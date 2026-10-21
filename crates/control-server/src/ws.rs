use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use liaper_common::{
    ClientToControlMsg, ControlToClientMsg, EncryptedChatMessage, RoomInfo, RoomParticipantState,
};
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::state::{ControlState, StoredContactRequest};

pub async fn handle_client_socket(socket: WebSocket, state: Arc<ControlState>, user_id: Uuid) {
    let conn_id = Uuid::new_v4();
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ControlToClientMsg>();

    state
        .sessions
        .entry(user_id)
        .or_default()
        .push((conn_id, tx.clone()));

    let self_profile = match state.users_by_id.get(&user_id) {
        Some(u) => u.to_public(true),
        None => return,
    };

    info!(
        "Client connected: @{} ({})",
        self_profile.username, self_profile.id
    );

    let active_rooms: Vec<RoomInfo> = state.rooms.iter().map(|r| r.value().clone()).collect();
    let (contacts, incoming_requests, outgoing_requests) = state.user_contacts_bundle(&user_id);

    let welcome = ControlToClientMsg::Welcome {
        self_profile: self_profile.clone(),
        contacts: contacts.clone(),
        incoming_requests,
        outgoing_requests,
        active_rooms,
        media_nodes: state.list_nodes_sorted(),
    };
    let _ = tx.send(welcome);

    // Отправляем историю личных диалогов со взаимными контактами
    for contact in &contacts {
        let dm_id = ControlState::dm_room_id(&user_id, &contact.id);
        if let Some(messages) = state.room_chats.get(&dm_id) {
            if !messages.is_empty() {
                let _ = tx.send(ControlToClientMsg::RoomChatHistory {
                    room_id: dm_id,
                    messages: messages.clone(),
                });
            }
        }
    }

    // Оповещаем взаимные контакты об изменении онлайн-статуса
    state.notify_user_contacts_presence(&user_id);

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if ws_sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(frame)) = ws_receiver.next().await {
        if let Message::Text(text) = frame {
            match serde_json::from_str::<ClientToControlMsg>(&text) {
                Ok(cmd) => process_client_command(&state, user_id, cmd),
                Err(err) => {
                    warn!("Invalid WS message from {}: {}", user_id, err);
                    state.send_to_user(
                        &user_id,
                        &ControlToClientMsg::Error {
                            message: format!("Некорректный формат команды: {}", err),
                        },
                    );
                }
            }
        }
    }

    send_task.abort();
    if let Some(mut conns) = state.sessions.get_mut(&user_id) {
        conns.retain(|(id, _)| *id != conn_id);
    }

    if !state.is_user_online(&user_id) {
        remove_user_from_all_rooms(&state, user_id);
        state.notify_user_contacts_presence(&user_id);
    }

    info!("Client disconnected: @{}", self_profile.username);
}

fn process_client_command(state: &Arc<ControlState>, user_id: Uuid, cmd: ClientToControlMsg) {
    let caller = match state.users_by_id.get(&user_id) {
        Some(u) => u.clone(),
        None => return,
    };

    match cmd {
        // ====================================================================
        // Взаимные Контакты и Заявки
        // ====================================================================
        ClientToControlMsg::SendContactRequest { target_username } => {
            let norm = ControlState::normalize_username(&target_username);
            let target_id = match state.user_id_by_username.get(&norm) {
                Some(id) => *id,
                None => {
                    state.send_to_user(
                        &caller.id,
                        &ControlToClientMsg::Error {
                            message: format!("Пользователь @{} не найден", norm),
                        },
                    );
                    return;
                }
            };

            if target_id == caller.id {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Нельзя добавить в контакты самого себя".to_string(),
                    },
                );
                return;
            }

            if state.are_contacts(&caller.id, &target_id) {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: format!("Пользователь @{} уже в ваших контактах", norm),
                    },
                );
                return;
            }

            // Если от этого пользователя уже есть встречная заявка к нам — автоматически подтверждаем взаимный контакт!
            let reverse_req_id = state
                .contact_requests
                .iter()
                .find(|e| e.from_user_id == target_id && e.to_user_id == caller.id)
                .map(|e| *e.key());

            if let Some(req_id) = reverse_req_id {
                state.contact_requests.remove(&req_id);
                state.add_mutual_contact(caller.id, target_id);
                state.push_contacts_update(&caller.id);
                state.push_contacts_update(&target_id);
                return;
            }

            // Проверяем, не отправлена ли уже заявка
            let already_sent = state
                .contact_requests
                .iter()
                .any(|e| e.from_user_id == caller.id && e.to_user_id == target_id);

            if already_sent {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: format!("Заявка для @{} уже отправлена и ожидает подтверждения", norm),
                    },
                );
                return;
            }

            let req = StoredContactRequest {
                id: Uuid::new_v4(),
                from_user_id: caller.id,
                to_user_id: target_id,
                created_at: Utc::now(),
            };
            state.contact_requests.insert(req.id, req);
            state.save_contacts_to_disk();

            state.push_contacts_update(&caller.id);
            state.push_contacts_update(&target_id);
        }

        ClientToControlMsg::RespondContactRequest { request_id, accept } => {
            let req = match state.contact_requests.get(&request_id) {
                Some(r) => r.clone(),
                None => return,
            };

            if req.to_user_id != caller.id {
                return;
            }

            state.contact_requests.remove(&request_id);
            if accept {
                state.add_mutual_contact(req.from_user_id, req.to_user_id);
            } else {
                state.save_contacts_to_disk();
            }

            state.push_contacts_update(&req.from_user_id);
            state.push_contacts_update(&req.to_user_id);
        }

        ClientToControlMsg::RemoveContact { contact_user_id } => {
            state.remove_mutual_contact(caller.id, contact_user_id);
            state.push_contacts_update(&caller.id);
            state.push_contacts_update(&contact_user_id);
        }

        // ====================================================================
        // Звонки и Групповые Уроки (только между взаимными контактами!)
        // ====================================================================
        ClientToControlMsg::CreateRoom {
            title,
            invited_usernames,
            preferred_region,
        } => {
            let assigned_node = state.select_least_loaded_node(preferred_region.as_deref());
            let room_id = Uuid::new_v4();
            let host_participant = RoomParticipantState {
                user_id: caller.id,
                username: caller.username.clone(),
                display_name: caller.display_name.clone(),
                role: caller.role.clone(),
                e2ee_public_key: caller.e2ee_public_key.clone(),
                key_fingerprint: caller.key_fingerprint.clone(),
                audio_enabled: true,
                video_enabled: false,
                screen_share_enabled: false,
                speaking: false,
            };

            let room = RoomInfo {
                id: room_id,
                title: if title.trim().is_empty() {
                    format!("Урок @{}", caller.username)
                } else {
                    title
                },
                host_id: caller.id,
                host_username: caller.username.clone(),
                assigned_node: assigned_node.clone(),
                participants: vec![host_participant],
                created_at: Utc::now(),
            };

            state.rooms.insert(room_id, room.clone());
            state.send_to_user(
                &caller.id,
                &ControlToClientMsg::RoomUpdated { room: room.clone() },
            );

            for raw_nick in invited_usernames {
                let norm = ControlState::normalize_username(&raw_nick);
                if let Some(target_id) = state.user_id_by_username.get(&norm) {
                    if *target_id != caller.id && state.are_contacts(&caller.id, &target_id) {
                        state.send_to_user(
                            &target_id,
                            &ControlToClientMsg::IncomingCall {
                                room: room.clone(),
                                caller: caller.to_public(true),
                                with_video: false,
                            },
                        );
                    }
                }
            }
        }

        ClientToControlMsg::CallByNick {
            target_username,
            with_video,
        } => {
            let norm = ControlState::normalize_username(&target_username);
            let target_id = match state.user_id_by_username.get(&norm) {
                Some(id) => *id,
                None => {
                    state.send_to_user(
                        &caller.id,
                        &ControlToClientMsg::Error {
                            message: format!("Пользователь @{} не найден", norm),
                        },
                    );
                    return;
                }
            };

            if target_id == caller.id {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Нельзя позвонить самому себе".to_string(),
                    },
                );
                return;
            }

            // Строгая проверка взаимных контактов перед звонком!
            if !state.are_contacts(&caller.id, &target_id) {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: format!(
                            "Нельзя позвонить @{}: сначала отправьте заявку и дождитесь подтверждения в контактах",
                            norm
                        ),
                    },
                );
                return;
            }

            let target_user = match state.users_by_id.get(&target_id) {
                Some(u) => u.clone(),
                None => return,
            };

            let assigned_node = state.select_least_loaded_node(None);
            let room_id = Uuid::new_v4();

            let host_participant = RoomParticipantState {
                user_id: caller.id,
                username: caller.username.clone(),
                display_name: caller.display_name.clone(),
                role: caller.role.clone(),
                e2ee_public_key: caller.e2ee_public_key.clone(),
                key_fingerprint: caller.key_fingerprint.clone(),
                audio_enabled: true,
                video_enabled: with_video,
                screen_share_enabled: false,
                speaking: false,
            };

            let room = RoomInfo {
                id: room_id,
                title: format!("{} ↔ {}", caller.display_name, target_user.display_name),
                host_id: caller.id,
                host_username: caller.username.clone(),
                assigned_node: assigned_node.clone(),
                participants: vec![host_participant],
                created_at: Utc::now(),
            };

            state.rooms.insert(room_id, room.clone());
            state.send_to_user(
                &caller.id,
                &ControlToClientMsg::RoomUpdated { room: room.clone() },
            );

            state.send_to_user(
                &target_id,
                &ControlToClientMsg::IncomingCall {
                    room,
                    caller: caller.to_public(true),
                    with_video,
                },
            );
        }

        ClientToControlMsg::InviteByNick {
            room_id,
            target_username,
        } => {
            let norm = ControlState::normalize_username(&target_username);
            let target_id = match state.user_id_by_username.get(&norm) {
                Some(id) => *id,
                None => {
                    state.send_to_user(
                        &caller.id,
                        &ControlToClientMsg::Error {
                            message: format!("Пользователь @{} не найден", norm),
                        },
                    );
                    return;
                }
            };

            if !state.are_contacts(&caller.id, &target_id) {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: format!(
                            "Пользователь @{} не состоит в ваших контактах",
                            norm
                        ),
                    },
                );
                return;
            }

            if let Some(room) = state.rooms.get(&room_id) {
                state.send_to_user(
                    &target_id,
                    &ControlToClientMsg::IncomingCall {
                        room: room.clone(),
                        caller: caller.to_public(true),
                        with_video: false,
                    },
                );
            }
        }

        ClientToControlMsg::JoinRoom {
            room_id,
            audio_enabled,
            video_enabled,
        } => {
            let mut updated_room = None;
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                if let Some(existing) = room
                    .participants
                    .iter_mut()
                    .find(|p| p.user_id == caller.id)
                {
                    existing.audio_enabled = audio_enabled;
                    existing.video_enabled = video_enabled;
                } else {
                    room.participants.push(RoomParticipantState {
                        user_id: caller.id,
                        username: caller.username.clone(),
                        display_name: caller.display_name.clone(),
                        role: caller.role.clone(),
                        e2ee_public_key: caller.e2ee_public_key.clone(),
                        key_fingerprint: caller.key_fingerprint.clone(),
                        audio_enabled,
                        video_enabled,
                        screen_share_enabled: false,
                        speaking: false,
                    });
                }
                updated_room = Some(room.clone());
            }

            if let Some(room) = updated_room {
                state.broadcast_to_room(&room_id, &ControlToClientMsg::RoomUpdated { room });

                if let Some(envelopes) = state.room_key_envelopes.get(&(room_id, caller.id)) {
                    for env in envelopes.iter() {
                        state.send_to_user(
                            &caller.id,
                            &ControlToClientMsg::KeyEnvelopeReceived {
                                envelope: env.clone(),
                            },
                        );
                    }
                }

                let messages = state
                    .room_chats
                    .get(&room_id)
                    .map(|m| m.clone())
                    .unwrap_or_default();
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::RoomChatHistory { room_id, messages },
                );
            } else {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Комната не найдена или звонок уже завершён".to_string(),
                    },
                );
            }
        }

        ClientToControlMsg::DeclineCall { room_id, reason } => {
            if let Some(room) = state.rooms.get(&room_id) {
                for p in &room.participants {
                    state.send_to_user(
                        &p.user_id,
                        &ControlToClientMsg::CallDeclined {
                            room_id,
                            declined_by: caller.username.clone(),
                            reason: reason.clone(),
                        },
                    );
                }
            }
        }

        ClientToControlMsg::LeaveRoom { room_id } => {
            remove_user_from_room(state, room_id, caller.id);
        }

        ClientToControlMsg::UpdateMediaState {
            room_id,
            audio_enabled,
            video_enabled,
            screen_share_enabled,
            speaking,
        } => {
            let mut updated_room = None;
            if let Some(mut room) = state.rooms.get_mut(&room_id) {
                if let Some(p) = room
                    .participants
                    .iter_mut()
                    .find(|p| p.user_id == caller.id)
                {
                    p.audio_enabled = audio_enabled;
                    p.video_enabled = video_enabled;
                    p.screen_share_enabled = screen_share_enabled;
                    p.speaking = speaking;
                    updated_room = Some(room.clone());
                }
            }
            if let Some(room) = updated_room {
                state.broadcast_to_room(&room_id, &ControlToClientMsg::RoomUpdated { room });
            }
        }

        ClientToControlMsg::SendKeyEnvelope { envelope } => {
            let recipient_id = envelope.recipient_id;
            let room_id = envelope.room_id;

            state
                .room_key_envelopes
                .entry((room_id, recipient_id))
                .or_default()
                .push(envelope.clone());

            state.send_to_user(
                &recipient_id,
                &ControlToClientMsg::KeyEnvelopeReceived { envelope },
            );
        }

        ClientToControlMsg::SendEncryptedChat {
            room_id,
            ciphertext_b64,
            iv_b64,
            room_key_id,
        } => {
            let msg = EncryptedChatMessage {
                id: Uuid::new_v4(),
                room_id,
                sender_id: caller.id,
                sender_username: caller.username.clone(),
                sender_display_name: caller.display_name.clone(),
                ciphertext_b64,
                iv_b64,
                room_key_id,
                created_at: Utc::now(),
            };

            state
                .room_chats
                .entry(room_id)
                .or_default()
                .push(msg.clone());
            state.save_chats_to_disk(Some(msg.clone()));

            if state.rooms.contains_key(&room_id) {
                state.broadcast_to_room(
                    &room_id,
                    &ControlToClientMsg::EncryptedChatReceived { message: msg },
                );
            } else {
                // Личный диалог с подтверждённым контактом
                let mut target_contact_id = None;
                if let Some(contact_ids) = state.contacts_by_user.get(&caller.id) {
                    for cid in contact_ids.iter() {
                        if ControlState::dm_room_id(&caller.id, cid) == room_id {
                            target_contact_id = Some(*cid);
                            break;
                        }
                    }
                }
                if let Some(peer_id) = target_contact_id {
                    let event = ControlToClientMsg::EncryptedChatReceived { message: msg };
                    state.send_to_user(&caller.id, &event);
                    if peer_id != caller.id {
                        state.send_to_user(&peer_id, &event);
                    }
                }
            }
        }
    }
}

fn remove_user_from_room(state: &Arc<ControlState>, room_id: Uuid, user_id: Uuid) {
    let mut updated_room = None;
    let mut should_remove_room = false;

    if let Some(mut room) = state.rooms.get_mut(&room_id) {
        room.participants.retain(|p| p.user_id != user_id);
        if room.participants.is_empty() {
            should_remove_room = true;
        } else {
            updated_room = Some(room.clone());
        }
    }

    if should_remove_room {
        state.rooms.remove(&room_id);
    } else if let Some(room) = updated_room {
        state.broadcast_to_room(&room_id, &ControlToClientMsg::RoomUpdated { room });
    }
}

fn remove_user_from_all_rooms(state: &Arc<ControlState>, user_id: Uuid) {
    let room_ids: Vec<Uuid> = state
        .rooms
        .iter()
        .filter(|r| r.participants.iter().any(|p| p.user_id == user_id))
        .map(|r| *r.key())
        .collect();

    for room_id in room_ids {
        remove_user_from_room(state, room_id, user_id);
    }
}
