-- Frozen pre-trusted-device schema from c681048, src/server/messaging/store-core.ts.
-- Keep independent of current constructors so this tests a populated older DO database.

      CREATE TABLE IF NOT EXISTS im_uid_allocator (
        name TEXT PRIMARY KEY, last_uid TEXT NOT NULL CHECK(typeof(last_uid)='text')
      );
      INSERT OR IGNORE INTO im_uid_allocator(name,last_uid) VALUES ('user','9999999');
      CREATE TABLE IF NOT EXISTS im_users (
        id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id)='text' AND length(id)>0 AND id NOT GLOB '*[^0-9]*' AND substr(id,1,1)<>'0'),
        kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
        username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT,
        owner_id TEXT REFERENCES im_users(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES im_users(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_account_crypto (
        user_id TEXT PRIMARY KEY REFERENCES im_users(id), vault TEXT NOT NULL,
        recovery_hash TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_vault_items (
        user_id TEXT NOT NULL REFERENCES im_users(id), id TEXT NOT NULL,
        revision INTEGER NOT NULL, ciphertext TEXT, PRIMARY KEY(user_id,id)
      );
      CREATE INDEX IF NOT EXISTS im_sessions_user ON im_sessions(user_id);
      CREATE TABLE IF NOT EXISTS im_invites (
        hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES im_users(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_contacts (
        user_id TEXT NOT NULL REFERENCES im_users(id), contact_id TEXT NOT NULL REFERENCES im_users(id),
        remark TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,contact_id)
      );
      CREATE TABLE IF NOT EXISTS im_conversations (
        id TEXT PRIMARY KEY, low_id TEXT REFERENCES im_users(id), high_id TEXT REFERENCES im_users(id),
        kind TEXT NOT NULL DEFAULT 'direct', name TEXT NOT NULL DEFAULT '', owner_id TEXT REFERENCES im_users(id),
        closed INTEGER NOT NULL DEFAULT 0, UNIQUE(low_id,high_id)
      );
      CREATE TABLE IF NOT EXISTS im_members (
        conversation_id TEXT NOT NULL REFERENCES im_conversations(id), user_id TEXT NOT NULL REFERENCES im_users(id),
        read_sequence INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS im_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES im_conversations(id), sender_id TEXT NOT NULL REFERENCES im_users(id),
        client_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'complete',
        mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, request_fingerprint TEXT NOT NULL,
        UNIQUE(sender_id,client_id)
      );
      CREATE INDEX IF NOT EXISTS im_messages_conversation ON im_messages(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS im_messages_streaming ON im_messages(state,updated_at);
      CREATE TABLE IF NOT EXISTS im_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES im_users(id),
        type TEXT NOT NULL, conversation_id TEXT, message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS im_events_user ON im_events(user_id,sequence);
      CREATE TABLE IF NOT EXISTS im_files (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES im_conversations(id), user_id TEXT NOT NULL REFERENCES im_users(id),
        message_id TEXT REFERENCES im_messages(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_files_message ON im_files(message_id);
      CREATE TABLE IF NOT EXISTS im_message_features (
        message_id TEXT PRIMARY KEY REFERENCES im_messages(id), interaction TEXT,
        expires_at INTEGER, status TEXT, sticker INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS im_features_expiry ON im_message_features(status,expires_at);
      CREATE TABLE IF NOT EXISTS im_media_objects (
        kind TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(kind,id)
      );
      CREATE TABLE IF NOT EXISTS im_avatars (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES im_users(id), mime TEXT NOT NULL,
        size INTEGER NOT NULL, data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_stickers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES im_users(id), name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(user_id,source_id)
      );

ALTER TABLE im_files ADD COLUMN encrypted TEXT;
ALTER TABLE im_stickers ADD COLUMN encrypted TEXT;
ALTER TABLE im_files ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS im_object_gc(key TEXT PRIMARY KEY, not_before INTEGER NOT NULL);
