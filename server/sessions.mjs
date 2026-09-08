// Session management on top of Herdr's agent API.
//
// A "session" here is one Herdr workspace holding a single pane. Agent sessions
// have an adopted agent (claude, codex, …) with a tracked status; plain shell
// sessions are the same thing without one, so both list and close identically.

import * as herdr from './herdr.mjs';

// Herdr's own status vocabulary; 'unknown' covers a pane it hasn't classified.
export const STATUSES = ['working', 'blocked', 'idle', 'done', 'unknown'];

export async function agentKinds() {
  try {
    const res = await herdr.call('server.agent_manifests');
    const kinds = (res.manifests ?? []).map(m => m.agent).filter(Boolean).sort();
    return ['shell', ...kinds];
  } catch {
    return ['shell', 'claude', 'codex'];
  }
}

export async function listSessions() {
  const [snap, agentRes, panes] = await Promise.all([
    herdr.snapshot(),
    herdr.call('agent.list').catch(() => ({ agents: [] })),
    herdr.listPanes().catch(() => []),
  ]);

  const workspaces = new Map(
    (snap.snapshot?.workspaces ?? []).map(w => [w.workspace_id, w]));
  const agentsByPane = new Map(
    (agentRes.agents ?? []).map(a => [a.pane_id, a]));

  return panes.map(pane => {
    const agent = agentsByPane.get(pane.pane_id);
    const ws = workspaces.get(pane.workspace_id);
    return {
      workspaceId: pane.workspace_id,
      paneId: pane.pane_id,
      label: ws?.label ?? pane.workspace_id,
      name: agent?.name ?? null,
      kind: agent?.agent ?? null,
      isAgent: Boolean(agent),
      // launch_pending means the agent was started but not yet detected.
      status: agent?.launch_pending ? 'starting' : (agent?.agent_status ?? 'unknown'),
      cwd: pane.foreground_cwd || pane.cwd || '',
      title: pane.terminal_title_stripped || '',
      focused: Boolean(pane.focused),
    };
  }).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId, undefined, { numeric: true }));
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function createSession({ kind = 'shell', cwd, name, label } = {}) {
  const kinds = await agentKinds();
  if (!kinds.includes(kind)) throw new Error(`unsupported agent kind: ${kind}`);
  if (name && !NAME_OK.test(name)) {
    throw new Error('name must be 1-64 chars of letters, digits, dot, dash or underscore');
  }

  const ws = await herdr.call('workspace.create', {
    ...(cwd ? { cwd } : {}),
    ...(label ? { label } : {}),
    focus: false,
  });
  const paneId = ws.root_pane?.pane_id;
  const workspaceId = ws.workspace?.workspace_id;
  if (!paneId) throw new Error('workspace.create returned no pane');
  if (kind === 'shell') return { workspaceId, paneId, kind, name: null };

  // Roll the workspace back if the agent fails to launch, so a failed start
  // doesn't strand an empty workspace in the list.
  const agentName = name || `${kind}-${workspaceId}`;
  try {
    await herdr.call('agent.start', {
      name: agentName,
      kind,
      pane_id: paneId,
      timeout_ms: 60000,
    });
  } catch (err) {
    await herdr.call('workspace.close', { workspace_id: workspaceId }).catch(() => {});
    throw new Error(`could not start ${kind}: ${err.message}`);
  }
  return { workspaceId, paneId, kind, name: agentName };
}

export async function closeSession(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId required');
  await herdr.call('workspace.close', { workspace_id: workspaceId });
  return { closed: workspaceId };
}

export const promptAgent = (target, text) =>
  herdr.call('agent.prompt', { target, text });
