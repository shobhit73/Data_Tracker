/* Data layer — every Supabase call goes through Store. UI never touches supabase directly. */
window.Store = (() => {
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  let me = null; // row from public.users for the signed-in person

  function fail(error) { throw new Error(error.message || "Request failed"); }

  async function signUp(name, email, password) {
    if (!/@uzio\.com$/i.test(email.trim())) throw new Error("Use your @uzio.com email");
    const { error } = await sb.auth.signUp({
      email: email.trim(), password, options: { data: { name } },
    });
    if (error) fail(error);
  }

  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    if (error) fail(error);
  }

  async function signOut() { await sb.auth.signOut(); me = null; }

  async function loadMe() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { me = null; return null; }
    const { data, error } = await sb.from("users").select("*").eq("id", session.user.id).single();
    if (error) fail(error);
    me = data;
    return me;
  }

  const getMe = () => me;

  async function resetPassword(email) {
    if (!/@uzio\.com$/i.test(email.trim())) throw new Error("Enter your @uzio.com email first");
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) fail(error);
  }

  async function updatePassword(password) {
    const { error } = await sb.auth.updateUser({ password });
    if (error) fail(error);
  }

  function onPasswordRecovery(cb) {
    sb.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") cb(); });
  }

  async function listUsers() {
    const { data, error } = await sb.from("users").select("*").order("name");
    if (error) fail(error);
    return data;
  }

  async function updateUser(id, patch) {
    const { error } = await sb.from("users").update(patch).eq("id", id);
    if (error) fail(error);
  }

  async function getAdminEmails() {
    const { data, error } = await sb.from("app_config").select("value").eq("key", "admin_emails").single();
    if (error) fail(error);
    return data.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  async function setAdminEmails(list) {
    const { error } = await sb.from("app_config").update({ value: list.join(",") }).eq("key", "admin_emails");
    if (error) fail(error);
  }

  async function listClients() {
    const { data, error } = await sb.from("clients")
      .select(`*, implementor:users(name),
               tasks(id,title,status,assignee_id,assigned_team,due_date,
                     template:task_templates(phase,owner_team,sort_order),
                     assignee:users!tasks_assignee_id_fkey(name)),
               client_modules(module,opted,training_done)`)
      .order("dsp_name");
    if (error) fail(error);
    return data;
  }

  async function getClient(id) {
    const { data, error } = await sb.from("clients")
      .select(`*, implementor:users(name), client_modules(*),
               client_notes(*, author:users(name)),
               tasks(*, template:task_templates(phase,sort_order,owner_team), assignee:users!tasks_assignee_id_fkey(name),
                     task_notes(note,created_at,author:users(name)))`)
      .eq("id", id).single();
    if (error) fail(error);
    return data;
  }

  async function createClient(fields) {
    const { data, error } = await sb.from("clients").insert(fields).select().single();
    if (error) fail(error);
    return data;
  }

  async function updateClient(id, patch) {
    const { error } = await sb.from("clients").update(patch).eq("id", id);
    if (error) fail(error);
  }

  async function updateModule(id, patch) {
    const { error } = await sb.from("client_modules").update(patch).eq("id", id);
    if (error) fail(error);
  }

  async function createTask(fields) { // ad-hoc task: template_id stays null
    const { error } = await sb.from("tasks").insert({ ...fields, created_by: me.id });
    if (error) fail(error);
  }

  async function updateTask(id, patch) {
    const { error } = await sb.from("tasks").update(patch).eq("id", id);
    if (error) fail(error);
  }

  async function addNote(taskId, note) {
    const { error } = await sb.from("task_notes").insert({ task_id: taskId, author_id: me.id, note });
    if (error) fail(error);
  }

  async function addClientNote(clientId, scope, note) {
    const { error } = await sb.from("client_notes")
      .insert({ client_id: clientId, scope, author_id: me.id, note });
    if (error) fail(error);
  }

  function ownedTasksQuery() {
    return sb.from("tasks")
      .select(`*, client:clients(id,dsp_name,short_code,vendor,implementor_id,implementor:users(name)),
               assignee:users!tasks_assignee_id_fkey(name),
               template:task_templates(phase,owner_team),
               task_notes(note,created_at,author:users(name))`);
  }

  async function listOpenTasks() {
    const { data, error } = await ownedTasksQuery()
      .in("status", ["Open", "In Progress"]).order("created_at");
    if (error) fail(error);
    return data;
  }

  async function listDoneTasks() {
    const { data, error } = await ownedTasksQuery().eq("status", "Done")
      .order("done_date", { ascending: false, nullsFirst: false }).limit(100);
    if (error) fail(error);
    return data;
  }

  async function getTeams() {
    const { data, error } = await sb.from("app_config").select("*").like("key", "team_%");
    if (error) fail(error);
    const keys = { "Data Team": "team_data_team", "Tax Team": "team_tax_team", "Shruti": "team_pto" };
    const out = {};
    for (const [team, key] of Object.entries(keys)) {
      const row = (data || []).find((r) => r.key === key);
      out[team] = (row?.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    return out;
  }

  async function listLastActivity() {
    const { data, error } = await sb.from("client_last_activity").select("*");
    if (error) { console.warn("listLastActivity:", error.message); return []; }
    return data;
  }

  /* Phase 2 data views (read-only reporting tables, filled by the dashboard's
     push script — the app only ever selects from them). */
  async function listReport(table, orderCol, ascending = true) {
    const { data, error } = await sb.from(table).select("*").order(orderCol, { ascending });
    if (error) fail(error);
    return data;
  }
  const listApiActivity      = () => listReport("api_activity_runs", "client_name");
  const listPayrollHealth    = () => listReport("payroll_health", "gap_days", false);
  const listDataCoverage     = () => listReport("client_data_coverage", "company_name");
  const listDocumentTransfers = () => listReport("document_transfer", "client_name");
  const listDocumentCounts   = () => listReport("client_document_counts", "company_name");
  const listHistClients      = () => listReport("hist_clients", "dsp_name");
  const listHistStatus       = () => listReport("hist_status", "dsp_short_code");
  const listHistOutOfScope   = () => listReport("hist_out_of_scope", "dsp_name");

  /* Everything the Client 360 platform panel needs, keyed by the CRM client's
     short code. Reads warn instead of failing so a reporting table that does
     not exist yet can never break the detail page itself. */
  async function listWhere(table, col, val) {
    const { data, error } = await sb.from(table).select("*").eq(col, val);
    if (error) { console.warn(`platform panel ${table}:`, error.message); return []; }
    return data || [];
  }
  async function getPlatformBundle(shortCode) {
    const [profile, sys, locs, cov, docs, health, hist, histPend] = await Promise.all([
      listWhere("client_profile", "dsp_short_code", shortCode),
      listWhere("client_system_activity", "dsp_short_code", shortCode),
      listWhere("client_work_locations", "dsp_short_code", shortCode),
      listWhere("client_data_coverage", "dsp_short_code", shortCode),
      listWhere("client_document_counts", "dsp_short_code", shortCode),
      listWhere("payroll_health", "dsp_short_code", shortCode),
      listWhere("hist_clients", "dsp_short_code", shortCode),
      listWhere("hist_status", "dsp_short_code", shortCode)
        .then((rows) => rows.filter((r) => r.status === "Pending")),
    ]);
    const fein = profile[0]?.fein || cov[0]?.fein || sys[0]?.fein || null;
    // The transfer record has no short code, only a client name — the whole
    // table is 25 rows, so fetch it and let the panel match by name.
    const [api, transfers] = await Promise.all([
      fein ? listWhere("api_activity_runs", "fein", fein) : Promise.resolve([]),
      sb.from("document_transfer").select("*")
        .then(({ data, error }) => { if (error) console.warn("platform panel document_transfer:", error.message); return data || []; }),
    ]);
    return { profile: profile[0] || null, sys: sys[0] || null, locs,
             cov: cov[0] || null, docs: docs[0] || null, health: health[0] || null,
             hist: hist[0] || null, histPend, api, transfers, fein };
  }

  async function getActivity(clientId) {
    const { data, error } = await sb.from("activity_log")
      .select("*, actor:users(name)")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) { console.warn("getActivity:", error.message); return []; }
    return data;
  }

  return { signUp, signIn, signOut, loadMe, getMe, resetPassword, updatePassword, onPasswordRecovery, listUsers, updateUser,
           getAdminEmails, setAdminEmails, listClients, getClient, createClient,
           updateClient, updateModule, createTask, updateTask, addNote, addClientNote,
           listOpenTasks, listDoneTasks, getTeams, listLastActivity, getActivity,
           listApiActivity, listPayrollHealth, listDataCoverage,
           listDocumentTransfers, listDocumentCounts,
           listHistClients, listHistStatus, listHistOutOfScope,
           getPlatformBundle };
})();
