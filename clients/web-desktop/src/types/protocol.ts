export type UserRole = 'tutor' | 'student';

export interface UserPublicProfile {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  e2ee_public_key: string;
  key_fingerprint: string;
  online: boolean;
}

export interface ContactRequestInfo {
  id: string;
  from_user: UserPublicProfile;
  to_user: UserPublicProfile;
  created_at: string;
}

export interface AuthResponse {
  token: string;
  user: UserPublicProfile;
}

export interface MediaNodeInfo {
  node_id: string;
  name: string;
  region: string;
  ws_url: string;
  http_url: string;
  active_rooms: number;
  active_peers: number;
  max_peers: number;
  cpu_usage_percent: number;
  memory_usage_percent: number;
  bandwidth_mbps: number;
  healthy: boolean;
  load_score: number;
  last_seen: string;
}

export interface E2eeKeyEnvelope {
  room_id: string;
  sender_id: string;
  sender_username: string;
  sender_public_key: string;
  recipient_id: string;
  recipient_username: string;
  encrypted_room_key_b64: string;
  iv_b64: string;
  room_key_id: string;
}

export interface EncryptedChatMessage {
  id: string;
  room_id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  ciphertext_b64: string;
  iv_b64: string;
  room_key_id: string;
  created_at: string;
  edited_at?: string | null;
}

export type AttachmentKind = 'pdf' | 'word' | 'image' | 'voice' | 'video_note';

export interface ChatAttachmentMeta {
  id: string;
  name: string;
  mime_type: string;
  kind: AttachmentKind;
  plaintext_size: number;
  ciphertext_size: number;
  file_key_b64: string;
  nonce_b64: string;
  sha256_hex: string;
  expires_at: string;
  duration_ms?: number;
  width?: number;
  height?: number;
}

export interface RichChatPayload {
  _liaper_msg: 1;
  text: string;
  attachment?: ChatAttachmentMeta;
}

export interface DecryptedChatMessage extends EncryptedChatMessage {
  plaintext: string;
  verified_e2ee: boolean;
  attachment?: ChatAttachmentMeta;
}

export interface RoomParticipantState {
  user_id: string;
  username: string;
  display_name: string;
  role: UserRole;
  e2ee_public_key: string;
  key_fingerprint: string;
  audio_enabled: boolean;
  video_enabled: boolean;
  screen_share_enabled: boolean;
  speaking: boolean;
}

export interface RoomInfo {
  id: string;
  title: string;
  host_id: string;
  host_username: string;
  assigned_node: MediaNodeInfo;
  participants: RoomParticipantState[];
  created_at: string;
}

export type AppPlatform =
  | 'windows_x86_64'
  | 'linux_x86_64'
  | 'android_arm64'
  | 'android_universal'
  | 'web';

export interface AppReleaseManifest {
  platform: AppPlatform;
  version: string;
  build_number: number;
  release_notes: string;
  download_url: string;
  sha256: string;
  signature: string;
  file_size_bytes: number;
  mandatory: boolean;
  published_at: string;
}

export interface UpdateCheckResponse {
  update_available: boolean;
  current_version: string;
  latest: AppReleaseManifest | null;
}

// ============================================================================
// WebSocket Control Plane Сообщения
// ============================================================================

export type ClientToControlMsg =
  | {
      type: 'send_contact_request';
      payload: {
        target_username: string;
      };
    }
  | {
      type: 'respond_contact_request';
      payload: {
        request_id: string;
        accept: boolean;
      };
    }
  | {
      type: 'remove_contact';
      payload: {
        contact_user_id: string;
      };
    }
  | {
      type: 'create_room';
      payload: {
        title: string;
        invited_usernames: string[];
        preferred_region?: string | null;
      };
    }
  | {
      type: 'call_by_nick';
      payload: {
        target_username: string;
        with_video: boolean;
      };
    }
  | {
      type: 'invite_by_nick';
      payload: {
        room_id: string;
        target_username: string;
      };
    }
  | {
      type: 'join_room';
      payload: {
        room_id: string;
        audio_enabled: boolean;
        video_enabled: boolean;
      };
    }
  | {
      type: 'decline_call';
      payload: {
        room_id: string;
        reason?: string | null;
      };
    }
  | {
      type: 'leave_room';
      payload: {
        room_id: string;
      };
    }
  | {
      type: 'update_media_state';
      payload: {
        room_id: string;
        audio_enabled: boolean;
        video_enabled: boolean;
        screen_share_enabled: boolean;
        speaking: boolean;
      };
    }
  | {
      type: 'send_key_envelope';
      payload: {
        envelope: E2eeKeyEnvelope;
      };
    }
  | {
      type: 'update_public_key';
      payload: {
        e2ee_public_key: string;
        key_fingerprint: string;
      };
    }
  | {
      type: 'send_encrypted_chat';
      payload: {
        room_id: string;
        ciphertext_b64: string;
        iv_b64: String | string;
        room_key_id: string;
      };
    }
  | {
      type: 'edit_encrypted_chat';
      payload: {
        room_id: string;
        message_id: string;
        ciphertext_b64: string;
        iv_b64: string;
        room_key_id: string;
      };
    }
  | {
      type: 'delete_encrypted_chat';
      payload: {
        room_id: string;
        message_id: string;
      };
    };

export type ControlToClientMsg =
  | {
      type: 'welcome';
      payload: {
        self_profile: UserPublicProfile;
        contacts: UserPublicProfile[];
        incoming_requests: ContactRequestInfo[];
        outgoing_requests: ContactRequestInfo[];
        active_rooms: RoomInfo[];
        media_nodes: MediaNodeInfo[];
      };
    }
  | {
      type: 'contacts_updated';
      payload: {
        contacts: UserPublicProfile[];
        incoming_requests: ContactRequestInfo[];
        outgoing_requests: ContactRequestInfo[];
      };
    }
  | {
      type: 'directory_updated';
      payload: {
        users: UserPublicProfile[];
      };
    }
  | {
      type: 'nodes_updated';
      payload: {
        nodes: MediaNodeInfo[];
      };
    }
  | {
      type: 'room_updated';
      payload: {
        room: RoomInfo;
      };
    }
  | {
      type: 'incoming_call';
      payload: {
        room: RoomInfo;
        caller: UserPublicProfile;
        with_video: boolean;
      };
    }
  | {
      type: 'call_declined';
      payload: {
        room_id: string;
        declined_by: string;
        reason?: string | null;
      };
    }
  | {
      type: 'key_envelope_received';
      payload: {
        envelope: E2eeKeyEnvelope;
      };
    }
  | {
      type: 'encrypted_chat_received';
      payload: {
        message: EncryptedChatMessage;
      };
    }
  | {
      type: 'encrypted_chat_edited';
      payload: {
        message: EncryptedChatMessage;
      };
    }
  | {
      type: 'encrypted_chat_deleted';
      payload: {
        room_id: string;
        message_id: string;
      };
    }
  | {
      type: 'room_chat_history';
      payload: {
        room_id: string;
        messages: EncryptedChatMessage[];
      };
    }
  | {
      type: 'error';
      payload: {
        message: string;
      };
    };

// ============================================================================
// WebSocket SFU Media Node Сообщения
// ============================================================================

export interface SfuPeerSummary {
  user_id: string;
  username: string;
  display_name: string;
  e2ee_enabled: boolean;
  room_key_id: string;
}

export interface IceServerConfig {
  urls: string[];
  username?: string | null;
  credential?: string | null;
}

export type ClientToNodeMsg =
  | {
      type: 'join_sfu_room';
      payload: {
        room_id: string;
        user_id: string;
        username: string;
        display_name: string;
        e2ee_enabled: boolean;
        room_key_id: string;
      };
    }
  | {
      type: 'encrypted_media_frame';
      payload: {
        room_id: string;
        kind: string;
        ciphertext_b64: string;
        iv_b64: string;
        room_key_id: string;
        timestamp_ms: number;
      };
    }
  | {
      type: 'leave_sfu_room';
      payload: {
        room_id: string;
      };
    };

export type NodeToClientMsg =
  | {
      type: 'sfu_room_joined';
      payload: {
        node_id: string;
        node_name: string;
        room_id: string;
        existing_peers: SfuPeerSummary[];
        ice_servers: IceServerConfig[];
      };
    }
  | {
      type: 'peer_joined_sfu';
      payload: {
        room_id: string;
        peer: SfuPeerSummary;
      };
    }
  | {
      type: 'peer_left_sfu';
      payload: {
        room_id: string;
        user_id: string;
      };
    }
  | {
      type: 'relayed_encrypted_media_frame';
      payload: {
        room_id: string;
        from_peer_id: string;
        from_username: string;
        kind: string;
        ciphertext_b64: string;
        iv_b64: string;
        room_key_id: string;
        timestamp_ms: number;
      };
    };
