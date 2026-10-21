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

    let active_rooms: Vec<RoomInfo> = state
        .rooms
        .iter()
        .filter(|r| r.participants.iter().any(|p| p.user_id == user_id))
        .map(|r| r.value().clone())
        .collect();
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

    // Доставляем сохранённые конверты E2EE-ключей перед историей сообщений
    for env in state.envelopes_for_recipient(&user_id) {
        let _ = tx.send(ControlToClientMsg::KeyEnvelopeReceived { envelope: env });
    }

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
                Ok(cmd) => process_client_command(&state, user_id, cmd).await,
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

async fn process_client_command(state: &Arc<ControlState>, user_id: Uuid, cmd: ClientToControlMsg) {
    let caller = match state.users_by_id.get(&user_id) {
        Some(u) => u.clone(),
        None => return,
    };
    let subj_key = format!("user:{user_id}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        state.send_to_user(&caller.id, &ControlToClientMsg::Error { message: msg });
        return;
    }
    if !state
        .antifraud
        .allow_rate(&format!("ws_cmd:{user_id}"), 10, 90)
    {
        state
            .antifraud
            .record_violation(
                &subj_key,
                Some(caller.id),
                Some(caller.username.clone()),
                None,
                "ws_flood",
                crate::antifraud::IncidentSeverity::Medium,
                25,
                "Флуд WebSocket-командами (> 90 команд за 10 сек.)".into(),
                180,
            )
            .await;
        state.send_to_user(
            &caller.id,
            &ControlToClientMsg::Error {
                message: "Сработала антифрод-защита: слишком частая отправка команд".into(),
            },
        );
        return;
    }
    let _contact_guard = if matches!(
        &cmd,
        ClientToControlMsg::SendContactRequest { .. }
            | ClientToControlMsg::RespondContactRequest { .. }
            | ClientToControlMsg::RemoveContact { .. }
    ) {
        Some(state.contact_mutations.lock().await)
    } else {
        None
    };

    match cmd {
        // ====================================================================
        // Взаимные Контакты и Заявки
        // ====================================================================
        ClientToControlMsg::SendContactRequest { target_username } => {
            if caller.role != liaper_common::UserRole::Tutor {
                state.send_to_user(&caller.id,&ControlToClientMsg::Error{message:"Приглашение в контакты отправляет преподаватель. Сообщите ему свой @ник".into()});
                return;
            }
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
            if let Err(e) = state.validate_student_addition(caller.id, target_id) {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: e.to_string(),
                    },
                );
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
                        message: format!(
                            "Заявка для @{} уже отправлена и ожидает подтверждения",
                            norm
                        ),
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
            if state.persist_contact_request(&req).await.is_err() {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Не удалось сохранить заявку в базе данных".into(),
                    },
                );
                return;
            }
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

            if let Err(e) = state
                .persist_contact_decision(req.from_user_id, req.to_user_id, request_id, accept)
                .await
            {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: if e.downcast_ref::<tokio_postgres::Error>().is_some() {
                            "Не удалось сохранить контакт в базе данных".into()
                        } else {
                            e.to_string()
                        },
                    },
                );
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
            if state
                .persist_contact_removal(caller.id, contact_user_id)
                .await
                .is_err()
            {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Не удалось удалить контакт из базы данных".into(),
                    },
                );
                return;
            }
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
            if !state
                .antifraud
                .allow_rate(&format!("call:{user_id}"), 60, 6)
            {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "call_spam",
                        crate::antifraud::IncidentSeverity::High,
                        40,
                        "Спам созданием уроков / Call Bombing (> 6 в минуту)".into(),
                        300,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Слишком частое создание уроков. Подождите минуту".into(),
                    },
                );
                return;
            }
            let hosted_rooms = state
                .rooms
                .iter()
                .filter(|r| r.host_id == caller.id)
                .count();
            if hosted_rooms >= crate::antifraud::MAX_ACTIVE_ROOMS_PER_HOST {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "call_spam",
                        crate::antifraud::IncidentSeverity::Medium,
                        25,
                        format!(
                            "Превышен лимит одновременно созданных активных комнат ({}/{})",
                            hosted_rooms,
                            crate::antifraud::MAX_ACTIVE_ROOMS_PER_HOST
                        ),
                        180,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "У вас уже открыто максимальное число активных уроков. Завершите текущий звонок".into(),
                    },
                );
                return;
            }
            let clean_title: String = title.trim().chars().take(80).collect();
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
                title: if clean_title.is_empty() {
                    format!("Урок @{}", caller.username)
                } else {
                    clean_title
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
                        state
                            .room_invitations
                            .entry(room_id)
                            .or_default()
                            .insert(*target_id);
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
            if !state
                .antifraud
                .allow_rate(&format!("call:{user_id}"), 60, 6)
            {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "call_spam",
                        crate::antifraud::IncidentSeverity::High,
                        40,
                        format!("Call Bombing на @{target_username} (> 6 вызовов в минуту)"),
                        300,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Слишком частые вызовы. Подождите минуту".into(),
                    },
                );
                return;
            }
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
            state
                .room_invitations
                .entry(room_id)
                .or_default()
                .insert(target_id);
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
                        message: format!("Пользователь @{} не состоит в ваших контактах", norm),
                    },
                );
                return;
            }

            if let Some(room) = state.rooms.get(&room_id) {
                if !room.participants.iter().any(|p| p.user_id == caller.id) {
                    state.send_to_user(
                        &caller.id,
                        &ControlToClientMsg::Error {
                            message: "Приглашать может только участник урока".into(),
                        },
                    );
                    return;
                }
                state
                    .room_invitations
                    .entry(room_id)
                    .or_default()
                    .insert(target_id);
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
            let allowed = state
                .rooms
                .get(&room_id)
                .is_some_and(|r| r.participants.iter().any(|p| p.user_id == caller.id))
                || state
                    .room_invitations
                    .get(&room_id)
                    .is_some_and(|ids| ids.contains(&caller.id));
            if !allowed {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Войти в урок можно только по приглашению".into(),
                    },
                );
                return;
            }
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
            if let Some(mut ids) = state.room_invitations.get_mut(&room_id) {
                if !ids.remove(&caller.id) {
                    return;
                }
            } else {
                return;
            }
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
            if envelope.encrypted_room_key_b64.len() > crate::antifraud::MAX_ENVELOPE_WRAPPED_KEY_LEN
                || envelope.sender_public_key.len() > 512
                || envelope.iv_b64.len() > 128
            {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "oversized_payload",
                        crate::antifraud::IncidentSeverity::Critical,
                        60,
                        format!(
                            "Попытка отправки аномально большого ключевого конверта ({} байт)",
                            envelope.encrypted_room_key_b64.len()
                        ),
                        600,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Ключевой конверт отклонён антифрод-системой (превышен допустимый размер)".into(),
                    },
                );
                return;
            }
            if envelope.sender_id != caller.id {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Недопустимый отправитель ключевого конверта".into(),
                    },
                );
                return;
            }
            let recipient_id = envelope.recipient_id;
            let room_id = envelope.room_id;
            let room_allowed = state.rooms.get(&room_id).is_some_and(|room| {
                room.participants.iter().any(|p| p.user_id == caller.id)
                    && (recipient_id == caller.id
                        || room.participants.iter().any(|p| p.user_id == recipient_id)
                        || state
                            .room_invitations
                            .get(&room_id)
                            .is_some_and(|ids| ids.contains(&recipient_id)))
            });
            let dm_allowed = state
                .contacts_by_user
                .get(&caller.id)
                .is_some_and(|contacts| {
                    contacts.iter().any(|cid| {
                        ControlState::dm_room_id(&caller.id, cid) == room_id
                            && (recipient_id == caller.id || recipient_id == *cid)
                    })
                });
            if !room_allowed && !dm_allowed {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Нет доступа для отправки ключа комнаты".into(),
                    },
                );
                return;
            }

            if state.upsert_key_envelope_in_memory(envelope.clone()) {
                let _ = state.persist_key_envelope(&envelope).await;
                state.save_envelopes_to_disk();
            }

            state.send_to_user(
                &recipient_id,
                &ControlToClientMsg::KeyEnvelopeReceived { envelope },
            );
        }

        ClientToControlMsg::UpdatePublicKey {
            e2ee_public_key,
            key_fingerprint,
        } => {
            let mut updated_user = None;
            if let Some(mut u) = state.users_by_id.get_mut(&caller.id) {
                u.merge_public_key(&e2ee_public_key, &key_fingerprint);
                updated_user = Some(u.clone());
            }
            if let Some(u) = updated_user {
                let _ = state.persist_user(&u).await;
                state.save_users_to_disk();

                let mut updated_rooms = Vec::new();
                for mut room_entry in state.rooms.iter_mut() {
                    let room = room_entry.value_mut();
                    let mut changed = false;
                    for p in room.participants.iter_mut() {
                        if p.user_id == caller.id {
                            p.e2ee_public_key = u.e2ee_public_key.clone();
                            p.key_fingerprint = u.key_fingerprint.clone();
                            changed = true;
                        }
                    }
                    if changed {
                        updated_rooms.push(room.clone());
                    }
                }
                for room in updated_rooms {
                    let rid = room.id;
                    state.broadcast_to_room(&rid, &ControlToClientMsg::RoomUpdated { room });
                }

                state.push_contacts_update(&caller.id);
                state.notify_user_contacts_presence(&caller.id);
                state.broadcast_all(&ControlToClientMsg::DirectoryUpdated {
                    users: state.all_public_users(),
                });
            }
        }

        ClientToControlMsg::SendEncryptedChat {
            room_id,
            ciphertext_b64,
            iv_b64,
            room_key_id,
        } => {
            if ciphertext_b64.is_empty()
                || ciphertext_b64.len() > crate::antifraud::MAX_CHAT_CIPHERTEXT_B64_LEN
                || iv_b64.len() > 128
                || room_key_id.len() > 64
            {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "oversized_payload",
                        crate::antifraud::IncidentSeverity::Critical,
                        60,
                        format!(
                            "Memory Bomb Guard: отклонён гигантский пакет чата ({} байт)",
                            ciphertext_b64.len()
                        ),
                        600,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Сообщение отклонено антифрод-системой: превышен лимит размера зашифрованного пакета (64 КиБ)".into(),
                    },
                );
                return;
            }
            if !state
                .antifraud
                .allow_rate(&format!("chat:{user_id}"), 10, 40)
            {
                state
                    .antifraud
                    .record_violation(
                        &subj_key,
                        Some(caller.id),
                        Some(caller.username.clone()),
                        None,
                        "ws_flood",
                        crate::antifraud::IncidentSeverity::Medium,
                        30,
                        "Спам сообщениями в чате (> 40 сообщений за 10 сек.)".into(),
                        180,
                    )
                    .await;
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Слишком быстрая отправка сообщений. Подождите несколько секунд".into(),
                    },
                );
                return;
            }
            let room_allowed = state
                .rooms
                .get(&room_id)
                .is_some_and(|room| room.participants.iter().any(|p| p.user_id == caller.id));
            let dm_allowed = state
                .contacts_by_user
                .get(&caller.id)
                .is_some_and(|contacts| {
                    contacts
                        .iter()
                        .any(|id| ControlState::dm_room_id(&caller.id, id) == room_id)
                });
            if !room_allowed && !dm_allowed {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Нет доступа к этому чату".into(),
                    },
                );
                return;
            }
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
                edited_at: None,
            };

            if let Err(e) = state.persist_chat(&msg).await {
                tracing::error!("Chat persistence failed: {}", e);
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Сообщение не сохранено: база данных недоступна".into(),
                    },
                );
                return;
            }
            state
                .room_chats
                .entry(room_id)
                .or_default()
                .push(msg.clone());
            state.save_chats_to_disk();

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

        ClientToControlMsg::EditEncryptedChat {
            room_id,
            message_id,
            ciphertext_b64,
            iv_b64,
            room_key_id,
        } => {
            if ciphertext_b64.is_empty()
                || ciphertext_b64.len() > crate::antifraud::MAX_CHAT_CIPHERTEXT_B64_LEN
                || iv_b64.len() > 128
                || room_key_id.len() > 64
            {
                state.send_to_user(
                    &caller.id,
                    &ControlToClientMsg::Error {
                        message: "Отредактированное сообщение превышает допустимый размер".into(),
                    },
                );
                return;
            }

            let mut edited_msg = None;
            if let Some(mut list) = state.room_chats.get_mut(&room_id) {
                if let Some(item) = list.iter_mut().find(|m| m.id == message_id) {
                    if item.sender_id != caller.id {
                        state.send_to_user(
                            &caller.id,
                            &ControlToClientMsg::Error {
                                message: "Редактировать можно только свои сообщения".into(),
                            },
                        );
                        return;
                    }
                    item.ciphertext_b64 = ciphertext_b64;
                    item.iv_b64 = iv_b64;
                    item.room_key_id = room_key_id;
                    item.edited_at = Some(Utc::now());
                    edited_msg = Some(item.clone());
                }
            }

            if let Some(msg) = edited_msg {
                let _ = state.persist_chat(&msg).await;
                state.save_chats_to_disk();

                let event = ControlToClientMsg::EncryptedChatEdited { message: msg };
                if state.rooms.contains_key(&room_id) {
                    state.broadcast_to_room(&room_id, &event);
                } else {
                    let mut target_contact_id = None;
                    if let Some(contact_ids) = state.contacts_by_user.get(&caller.id) {
                        for cid in contact_ids.iter() {
                            if ControlState::dm_room_id(&caller.id, cid) == room_id {
                                target_contact_id = Some(*cid);
                                break;
                            }
                        }
                    }
                    state.send_to_user(&caller.id, &event);
                    if let Some(peer_id) = target_contact_id {
                        if peer_id != caller.id {
                            state.send_to_user(&peer_id, &event);
                        }
                    }
                }
            }
        }

        ClientToControlMsg::DeleteEncryptedChat {
            room_id,
            message_id,
        } => {
            let mut removed = false;
            if let Some(mut list) = state.room_chats.get_mut(&room_id) {
                if let Some(pos) = list.iter().position(|m| m.id == message_id) {
                    if list[pos].sender_id != caller.id {
                        state.send_to_user(
                            &caller.id,
                            &ControlToClientMsg::Error {
                                message: "Удалять можно только свои сообщения".into(),
                            },
                        );
                        return;
                    }
                    list.remove(pos);
                    removed = true;
                }
            }

            if removed {
                let _ = state
                    .delete_chat_from_pg(&message_id, &room_id, &caller.id)
                    .await;
                state.save_chats_to_disk();

                let event = ControlToClientMsg::EncryptedChatDeleted {
                    room_id,
                    message_id,
                };
                if state.rooms.contains_key(&room_id) {
                    state.broadcast_to_room(&room_id, &event);
                } else {
                    let mut target_contact_id = None;
                    if let Some(contact_ids) = state.contacts_by_user.get(&caller.id) {
                        for cid in contact_ids.iter() {
                            if ControlState::dm_room_id(&caller.id, cid) == room_id {
                                target_contact_id = Some(*cid);
                                break;
                            }
                        }
                    }
                    state.send_to_user(&caller.id, &event);
                    if let Some(peer_id) = target_contact_id {
                        if peer_id != caller.id {
                            state.send_to_user(&peer_id, &event);
                        }
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
        state.room_invitations.remove(&room_id);
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

#[cfg(test)]
mod contact_tests {
    use super::*;
    use crate::state::StoredUser;
    use base64::Engine as _;
    use liaper_common::UserRole;
    #[tokio::test]
    async fn only_tutors_invite_students_and_tenth_slot_is_atomic() {
        let root = std::env::temp_dir().join(format!("liaper-contact-test-{}", Uuid::new_v4()));
        let state = ControlState::new(root.join("users.json"));
        let add = |role| {
            let id = Uuid::new_v4();
            let username = id.simple().to_string();
            state.users_by_id.insert(
                id,
                StoredUser {
                    id,
                    username: username.clone(),
                    display_name: "Test".into(),
                    password_hash: "hash".into(),
                    salt_b64: "salt".into(),
                    role,
                    e2ee_public_key: "key".into(),
                    key_fingerprint: "fingerprint".into(),
                },
            );
            state.user_id_by_username.insert(username, id);
            id
        };
        let tutor = add(UserRole::Tutor);
        let tutor2 = add(UserRole::Tutor);
        let students: Vec<_> = (0..11).map(|_| add(UserRole::Student)).collect();
        let invite = |target: Uuid| ClientToControlMsg::SendContactRequest {
            target_username: target.simple().to_string(),
        };
        process_client_command(&state, students[0], invite(students[1])).await;
        process_client_command(&state, students[0], invite(tutor)).await;
        process_client_command(&state, tutor, invite(tutor2)).await;
        assert!(state.contact_requests.is_empty());
        for student in &students {
            process_client_command(&state, tutor, invite(*student)).await;
        }
        let requests: Vec<_> = students
            .iter()
            .map(|id| {
                state
                    .contact_requests
                    .iter()
                    .find(|r| r.to_user_id == *id)
                    .unwrap()
                    .id
            })
            .collect();
        for i in 0..9 {
            process_client_command(
                &state,
                students[i],
                ClientToControlMsg::RespondContactRequest {
                    request_id: requests[i],
                    accept: true,
                },
            )
            .await;
        }
        tokio::join!(
            process_client_command(
                &state,
                students[9],
                ClientToControlMsg::RespondContactRequest {
                    request_id: requests[9],
                    accept: true
                }
            ),
            process_client_command(
                &state,
                students[10],
                ClientToControlMsg::RespondContactRequest {
                    request_id: requests[10],
                    accept: true
                }
            )
        );
        assert_eq!(state.student_count(tutor), 10);
        let pending = state.contact_requests.iter().next().unwrap().clone();
        process_client_command(
            &state,
            tutor,
            ClientToControlMsg::RemoveContact {
                contact_user_id: students[0],
            },
        )
        .await;
        process_client_command(
            &state,
            pending.to_user_id,
            ClientToControlMsg::RespondContactRequest {
                request_id: pending.id,
                accept: true,
            },
        )
        .await;
        assert_eq!(state.student_count(tutor), 10);
        assert!(state.are_contacts(&tutor, &pending.to_user_id));
        process_client_command(
            &state,
            tutor,
            ClientToControlMsg::CreateRoom {
                title: "Test lesson".into(),
                invited_usernames: vec![students[1].simple().to_string()],
                preferred_region: None,
            },
        )
        .await;
        let room = state.rooms.iter().next().unwrap().id;
        process_client_command(
            &state,
            tutor2,
            ClientToControlMsg::JoinRoom {
                room_id: room,
                audio_enabled: false,
                video_enabled: false,
            },
        )
        .await;
        assert_eq!(state.rooms.get(&room).unwrap().participants.len(), 1);
        process_client_command(
            &state,
            students[2],
            ClientToControlMsg::InviteByNick {
                room_id: room,
                target_username: tutor.simple().to_string(),
            },
        )
        .await;
        assert!(!state.room_invitations.get(&room).unwrap().contains(&tutor));
        process_client_command(
            &state,
            students[1],
            ClientToControlMsg::JoinRoom {
                room_id: room,
                audio_enabled: false,
                video_enabled: false,
            },
        )
        .await;
        assert_eq!(state.rooms.get(&room).unwrap().participants.len(), 2);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn key_envelope_requires_room_or_dm_membership_and_merges_x25519_keys() {
        let root = std::env::temp_dir().join(format!("liaper-keyenv-test-{}", Uuid::new_v4()));
        let state = ControlState::new(root.join("users.json"));
        let add = |role| {
            let id = Uuid::new_v4();
            let username = id.simple().to_string();
            state.users_by_id.insert(
                id,
                StoredUser {
                    id,
                    username: username.clone(),
                    display_name: "Test".into(),
                    password_hash: "hash".into(),
                    salt_b64: "salt".into(),
                    role,
                    e2ee_public_key: "legacy_non_32_byte_key".into(),
                    key_fingerprint: "fp".into(),
                },
            );
            state.user_id_by_username.insert(username, id);
            id
        };
        let tutor = add(UserRole::Tutor);
        let student = add(UserRole::Student);
        let outsider = add(UserRole::Student);
        state.add_mutual_contact(tutor, student);

        let key1 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let key2 = base64::engine::general_purpose::STANDARD.encode([2u8; 32]);
        process_client_command(
            &state,
            tutor,
            ClientToControlMsg::UpdatePublicKey {
                e2ee_public_key: key1.clone(),
                key_fingerprint: "0101:0101".into(),
            },
        )
        .await;
        process_client_command(
            &state,
            tutor,
            ClientToControlMsg::UpdatePublicKey {
                e2ee_public_key: key2.clone(),
                key_fingerprint: "0202:0202".into(),
            },
        )
        .await;
        let merged = state.users_by_id.get(&tutor).unwrap().e2ee_public_key.clone();
        assert_eq!(merged, format!("{},{}", key2, key1));

        let dm_room = ControlState::dm_room_id(&tutor, &student);
        let valid_env = liaper_common::E2eeKeyEnvelope {
            room_id: dm_room,
            sender_id: tutor,
            sender_username: "tutor".into(),
            sender_public_key: key2.clone(),
            recipient_id: student,
            recipient_username: "student".into(),
            encrypted_room_key_b64: "cipher".into(),
            iv_b64: "iv".into(),
            room_key_id: "ABCD:1234".into(),
        };
        // Outsider cannot inject key envelope into tutor-student DM
        let mut spoofed = valid_env.clone();
        spoofed.sender_id = outsider;
        process_client_command(
            &state,
            outsider,
            ClientToControlMsg::SendKeyEnvelope { envelope: spoofed },
        )
        .await;
        assert!(state.envelopes_for_recipient(&student).is_empty());

        // Tutor can send key envelope to student in their DM
        process_client_command(
            &state,
            tutor,
            ClientToControlMsg::SendKeyEnvelope {
                envelope: valid_env,
            },
        )
        .await;
        assert_eq!(state.envelopes_for_recipient(&student).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
