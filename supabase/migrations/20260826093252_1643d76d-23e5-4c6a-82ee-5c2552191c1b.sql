DROP POLICY IF EXISTS "daemon state readable" ON public.daemon_state;
REVOKE SELECT ON public.daemon_state FROM authenticated;
GRANT ALL ON public.daemon_state TO service_role;