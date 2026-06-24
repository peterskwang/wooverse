-- Phase 4 SOS: acknowledgement and emergency-contact fallback

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  relationship TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user_id
  ON emergency_contacts (user_id);

CREATE TABLE IF NOT EXISTS sos_contact_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id UUID NOT NULL REFERENCES sos_events(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES emergency_contacts(id) ON DELETE SET NULL,
  phone_e164 TEXT,
  status TEXT NOT NULL,
  provider_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sos_contact_notifications_sos_id
  ON sos_contact_notifications (sos_id);

ALTER TABLE sos_events
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS sms_fallback_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_fallback_status TEXT;
