-- Up Migration

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_events_tenant_job ON job_events (tenant_id, job_id, id);

CREATE TABLE callback_configs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX callback_configs_tenant ON callback_configs (tenant_id, created_at DESC);

CREATE FUNCTION set_job_status(target_job uuid, target_status text, detail text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_tenant text;
BEGIN
  UPDATE jobs
     SET status=target_status,
         progress=CASE WHEN target_status='completed' AND detail IS NOT NULL THEN detail::jsonb ELSE progress END,
         error=CASE WHEN target_status='failed' THEN detail ELSE error END,
         started_at=CASE WHEN target_status='running' THEN coalesce(started_at,now()) ELSE started_at END,
         finished_at=CASE WHEN target_status IN ('completed','failed') THEN now() ELSE finished_at END,
         updated_at=now()
   WHERE id=target_job
   RETURNING tenant_id INTO target_tenant;
  IF target_tenant IS NULL THEN RAISE EXCEPTION 'job_not_found'; END IF;
  INSERT INTO job_events(job_id,tenant_id,event_type,status,payload)
  VALUES(target_job,target_tenant,'job.' || target_status,target_status,
         CASE WHEN detail IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('detail',detail) END);
END $$;

-- Down Migration

DROP FUNCTION set_job_status(uuid,text,text);
DROP TABLE callback_configs;
DROP TABLE job_events;
