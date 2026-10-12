DO $$
DECLARE
  ua uuid; ub uuid; oa uuid; ob uuid; fa uuid; fv uuid; r1 uuid; r2 uuid; n bigint;
  TABLES text[] := ARRAY['project','form','form_version','response','response_answer',
                         'response_attachment','dist_link','dist_invite','quota'];
  t text;
BEGIN
  -- A. identity -----------------------------------------------------------
  ua := app_find_or_create_user('a@example.org','A');
  ub := app_find_or_create_user('b@example.org','B');
  IF ua = ub THEN RAISE EXCEPTION 'A: identity fn merged two users'; END IF;
  IF app_find_or_create_user('a@example.org') <> ua THEN RAISE EXCEPTION 'A: not idempotent'; END IF;
  IF (SELECT count(*) FROM app_get_user('a@example.org')) <> 1 THEN RAISE EXCEPTION 'A: get_user'; END IF;

  -- B. org bootstrap ------------------------------------------------------
  PERFORM set_config('app.user_id', ua::text, false);
  oa := app_create_org('Org A','org-a');
  IF NOT app_is_member(oa)   THEN RAISE EXCEPTION 'B: creator not a member'; END IF;
  IF NOT app_has_org_role(oa, ARRAY['owner']) THEN RAISE EXCEPTION 'B: creator not owner'; END IF;
  PERFORM set_config('app.user_id', ub::text, false);
  ob := app_create_org('Org B','org-b');
  IF oa = ob THEN RAISE EXCEPTION 'B: orgs not distinct'; END IF;
  IF app_is_member(oa) THEN RAISE EXCEPTION 'B: B is a member of A org'; END IF;

  -- C. authoring as owner -------------------------------------------------
  PERFORM set_config('app.user_id', ua::text, false);
  PERFORM set_config('app.org_id',  oa::text, false);
  INSERT INTO project (org_id,name,slug) VALUES (oa,'P','p');
  INSERT INTO form (org_id,name,slug) VALUES (oa,'Form A','form-a') RETURNING id INTO fa;
  INSERT INTO form_version (org_id,form_id,version,status,title,definition)
    VALUES (oa,fa,1,'published','Form A v1','{"questions":[]}'::jsonb) RETURNING id INTO fv;
  INSERT INTO response (org_id,form_id,form_version_id) VALUES (oa,fa,fv) RETURNING id INTO r1;
  INSERT INTO response (org_id,form_id,form_version_id) VALUES (oa,fa,fv) RETURNING id INTO r2;
  INSERT INTO response_answer (org_id,response_id,question_id,value) VALUES (oa,r1,'q1','"x"'::jsonb);
  INSERT INTO response_attachment (org_id,response_id,question_id,filename,mime,size_bytes,storage_key)
    VALUES (oa,r1,'q_up','a.pdf','application/pdf',10,'k/a');
  INSERT INTO dist_link (org_id,form_id,kind) VALUES (oa,fa,'anonymous');
  INSERT INTO quota (org_id,form_id,name,target) VALUES (oa,fa,'main',100);
  INSERT INTO dist_invite (org_id,form_id,email) VALUES (oa,fa,'respondent@example.org');
  FOREACH t IN ARRAY TABLES LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> (CASE WHEN t = 'response' THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'C: owner sees % rows in %', n, t;
    END IF;
  END LOOP;

  -- D. cross-org READ: B must see nothing of A, whatever app.org_id claims --
  PERFORM set_config('app.user_id', ub::text, false);
  FOREACH t IN ARRAY TABLES LOOP
    PERFORM set_config('app.org_id', '', false);
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'D1: B saw % rows in % (no org ctx)', n, t; END IF;
    PERFORM set_config('app.org_id', oa::text, false);   -- forged
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'D2: FORGED org_id LEAK — B saw % rows in %', n, t; END IF;
  END LOOP;

  -- E. cross-org WRITE ----------------------------------------------------
  BEGIN INSERT INTO form (org_id,name,slug) VALUES (oa,'B into A','b-into-a');
    RAISE EXCEPTION 'E: B inserted into A org'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- RLS silently matches 0 rows for UPDATE/DELETE rather than raising
  UPDATE form SET name='pwned' WHERE org_id=oa;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'E: B updated % rows in A org', n; END IF;
  DELETE FROM form WHERE org_id=oa;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'E: B deleted % rows in A org', n; END IF;
  -- B legitimately owns its own org
  PERFORM set_config('app.org_id', ob::text, false);
  INSERT INTO form (org_id,name,slug) VALUES (ob,'B form','b-form');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'E: B could not author in its own org'; END IF;

  -- F. publish invariants -------------------------------------------------
  PERFORM set_config('app.user_id', ua::text, false);
  PERFORM set_config('app.org_id',  oa::text, false);
  INSERT INTO form_version (org_id,form_id,version,status,title,definition)
    VALUES (oa,fa,2,'draft','Form A v2','{"questions":[]}'::jsonb);
  BEGIN UPDATE form_version SET status='published' WHERE form_id=fa AND version=2;
    RAISE EXCEPTION 'F: second published version allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO form_version (org_id,form_id,version,status,title,definition)
    VALUES (oa,fa,3,'draft','Form A v3','{}'::jsonb);
    RAISE EXCEPTION 'F: second DRAFT allowed'; EXCEPTION WHEN unique_violation THEN NULL; END;

  -- G. role boundary: member may author, may not manage the roster --------
  INSERT INTO membership (org_id,user_id,role) VALUES (oa,ub,'member');
  PERFORM set_config('app.user_id', ub::text, false);
  PERFORM set_config('app.org_id',  oa::text, false);
  INSERT INTO form (org_id,name,slug) VALUES (oa,'B form in A','b-form-a');
  IF (SELECT count(*) FROM form WHERE org_id = oa) <> 2 THEN
    RAISE EXCEPTION 'G: member could not author in org A'; END IF;
  BEGIN INSERT INTO membership (org_id,user_id,role) VALUES (oa,ua,'viewer');
    RAISE EXCEPTION 'G: member could rewrite the roster'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- H. collector scope: one response, nothing else ------------------------
  PERFORM set_config('app.user_id','',false);
  PERFORM set_config('app.org_id', oa::text, false);
  PERFORM set_config('app.collector','on',false);
  PERFORM set_config('app.response_id', r1::text, false);
  FOREACH t IN ARRAY TABLES LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n > 1 THEN RAISE EXCEPTION 'H: collector saw % rows in % (max 1)', n, t; END IF;
  END LOOP;
  INSERT INTO response_answer (org_id,response_id,question_id,value) VALUES (oa,r1,'q2','"ok"'::jsonb);
  BEGIN INSERT INTO response_answer (org_id,response_id,question_id,value) VALUES (oa,r2,'q2','"sneak"'::jsonb);
    RAISE EXCEPTION 'H: collector wrote to another response'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT count(*) INTO n FROM response_answer; IF n <> 2 THEN RAISE EXCEPTION 'H: collector answer count %', n; END IF;

  RAISE NOTICE 'PLATFORM RLS + INVARIANTS: ALL PASSED';
END $$;
