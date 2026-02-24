/* ═══════════════════════════════════════════════════════════════
   Cognitive Graph Agent — app.js
   Reactive UI: Knowledge → Source → Mindmap → Document/Explore
═══════════════════════════════════════════════════════════════ */

'use strict';

// Global error catcher — surfaces runtime errors visually
window.addEventListener('error', function(ev) {
  console.error('[CGA] Uncaught error:', ev.message, 'at', ev.filename, ev.lineno);
  const list = document.getElementById('knowledge-list');
  if (list && !list.innerHTML.trim()) {
    list.innerHTML = `<div style="color:#f87171;font-size:10px;padding:6px;word-break:break-all">JS Error (line ${ev.lineno}): ${ev.message}</div>`;
  }
});
window.addEventListener('unhandledrejection', function(ev) {
  console.error('[CGA] Unhandled promise rejection:', ev.reason);
});

// ── State ─────────────────────────────────────────────────────────
const STATE = {
  activeContainerId: null,   // Knowledge đang chọn
  activeSourceId:    null,   // Source đang chọn
  selectedNodeId:    null,   // Node trong Mindmap đang chọn
  graphData:         { nodes: [], edges: [] },
  chatHistory:       [],
  chatHistories:     new Map(), // key: "node:{id}" or "container:{id}" → {messages, html}
  pendingSuggested:  [],     // nodes AI đề xuất đang chờ confirm
  selectedEdgeId:    null,   // Edge đang chọn để edit/delete
  nodePositions:     new Map(), // lưu vị trí node giữa các lần render: node_id → {x, y}
};

// ── localStorage helpers to persist chat across page refresh ────────────────
// We store only the serialisable messages array, not innerHTML (which
// is rebuilt deterministically from messages when re-hydrating).
const LS_KEY = 'cga_chat_histories';

function _lsLoad() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      STATE.chatHistories.set(k, v);
    }
  } catch(e) { /* ignore corrupt data */ }
}

function _lsSave() {
  try {
    const obj = {};
    for (const [k, v] of STATE.chatHistories.entries()) {
      // Only persist messages (html will be rebuilt on restore)
      obj[k] = { messages: v.messages };
    }
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch(e) { /* quota exceeded etc */ }
}

// ── API helpers ───────────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) { const e = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(e.detail || r.statusText); }
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(()=>({detail: r.statusText})); throw new Error(e.detail || r.statusText); }
    return r.json();
  },
  async patch(url, body) {
    const r = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(()=>({detail: r.statusText})); throw new Error(e.detail || r.statusText); }
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method:'DELETE' });
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  },
};

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg, dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), dur);
}

// ── Modal helpers ─────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
window.closeModal = closeModal;

// ═══════════════════════════════════════════════════════════════════
// COLUMN 1 — Knowledge
// ═══════════════════════════════════════════════════════════════════

async function loadKnowledge() {
  try {
    const containers = await api.get('/api/containers');
    console.log('[CGA] loadKnowledge: got', containers.length, 'containers');
    renderKnowledgeList(containers);
  } catch(e) {
    console.error('[CGA] loadKnowledge FAILED:', e);
    const list = document.getElementById('knowledge-list');
    if (list) list.innerHTML = `<div style="color:#f87171;font-size:11px;padding:8px">Lỗi tải: ${e.message}</div>`;
  }
}

function renderKnowledgeList(containers) {
  const list = document.getElementById('knowledge-list');
  list.innerHTML = '';
  containers.forEach(c => {
    const el = document.createElement('div');
    el.className = 'list-item' + (c.container_id === STATE.activeContainerId ? ' active' : '');
    el.textContent = c.title;
    el.title = c.description || c.title;
    el.dataset.id = c.container_id;
    el.addEventListener('click', () => selectKnowledge(c.container_id));
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = c.title;
      inp.className = 'list-item-edit';
      el.replaceWith(inp);
      inp.focus();
      inp.select();
      const finish = async (save) => {
        if (save) {
          const newTitle = inp.value.trim();
          if (newTitle && newTitle !== c.title) {
            try {
              await api.patch(`/api/containers/${c.container_id}`, { title: newTitle });
            } catch(err) { toast('Lỗi đổi tên: ' + err.message); }
          }
        }
        await loadKnowledge();
      };
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { finish(false); }
      });
      inp.addEventListener('blur', () => finish(false));
    });
    list.appendChild(el);
  });
}

async function selectKnowledge(containerId) {
  saveChatState();  // preserve chat for the node we're leaving
  STATE.activeContainerId = containerId;
  STATE.activeSourceId    = null;
  STATE.selectedNodeId    = null;
  STATE.nodePositions.clear();  // reset vị trí khi đổi container
  // Re-render knowledge list (highlight)
  document.querySelectorAll('#knowledge-list .list-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === containerId);
  });
  // Load sources + graph in parallel
  await Promise.all([loadSources(containerId), loadGraph(containerId)]);
  clearDocumentPanel();
  // Wipe chat entirely on container switch (different topic scope)
  STATE.chatHistory = [];
  STATE.pendingSuggested = [];
  document.getElementById('chat-display').innerHTML = '';
  document.getElementById('suggested-area').style.display = 'none';
}

document.getElementById('btn-add-knowledge').addEventListener('click', () => {
  document.getElementById('inp-kn-title').value = '';
  document.getElementById('inp-kn-desc').value = '';
  openModal('modal-add-knowledge');
});

document.getElementById('confirm-add-knowledge').addEventListener('click', async () => {
  const title = document.getElementById('inp-kn-title').value.trim();
  if (!title) { toast('Nhập tên chủ đề'); return; }
  try {
    await api.post('/api/containers', { title, description: document.getElementById('inp-kn-desc').value });
    closeModal('modal-add-knowledge');
    await loadKnowledge();
    toast('Đã thêm knowledge: ' + title);
  } catch(e) { toast('Lỗi: ' + e.message); }
});

document.getElementById('btn-remove-knowledge').addEventListener('click', async () => {
  if (!STATE.activeContainerId) { toast('Chọn một Knowledge trước'); return; }
  if (!confirm('Xoá Knowledge này và toàn bộ dữ liệu liên quan?')) return;
  try {
    await api.del('/api/containers/' + STATE.activeContainerId);
    STATE.activeContainerId = null;
    STATE.activeSourceId    = null;
    STATE.selectedNodeId    = null;
    await loadKnowledge();
    renderSourceList([]);
    renderGraph({ nodes: [], edges: [] });
    clearDocumentPanel();
    clearChat();
    toast('Đã xoá');
  } catch(e) { toast('Lỗi: ' + e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// COLUMN 2 — Source
// ═══════════════════════════════════════════════════════════════════

async function loadSources(containerId) {
  const sources = await api.get(`/api/containers/${containerId}/sources`);
  renderSourceList(sources);
}

function renderSourceList(sources) {
  const list = document.getElementById('source-list');
  list.innerHTML = '';
  if (!sources.length) {
    list.innerHTML = '<div style="color:#475569;font-size:11px;text-align:center;margin-top:12px">Chưa có source</div>';
    return;
  }
  sources.forEach(s => {
    const el = document.createElement('div');
    el.className = 'list-item' + (s.source_id === STATE.activeSourceId ? ' active' : '');
    el.title = s.path_or_url || s.label;
    el.dataset.id = s.source_id;
    el.innerHTML = `<span style="font-size:9px;opacity:.7">[${s.type}]</span> ${s.label}`;
    el.addEventListener('click', () => {
      STATE.activeSourceId = s.source_id;
      document.querySelectorAll('#source-list .list-item').forEach(x =>
        x.classList.toggle('active', x.dataset.id === s.source_id));
    });
    list.appendChild(el);
  });
}

document.getElementById('btn-add-source').addEventListener('click', () => {
  if (!STATE.activeContainerId) { toast('Chọn Knowledge trước'); return; }
  document.getElementById('inp-src-label').value = '';
  document.getElementById('inp-src-path').value  = '';
  document.getElementById('inp-src-notes').value = '';
  openModal('modal-add-source');
});

document.getElementById('confirm-add-source').addEventListener('click', async () => {
  const label = document.getElementById('inp-src-label').value.trim();
  if (!label) { toast('Nhập tên source'); return; }
  try {
    await api.post(`/api/containers/${STATE.activeContainerId}/sources`, {
      container_id: STATE.activeContainerId,
      type:         document.getElementById('inp-src-type').value,
      label,
      path_or_url:  document.getElementById('inp-src-path').value.trim(),
      notes:        document.getElementById('inp-src-notes').value.trim(),
    });
    closeModal('modal-add-source');
    await loadSources(STATE.activeContainerId);
    toast('Đã thêm source: ' + label);
  } catch(e) { toast('Lỗi: ' + e.message); }
});

document.getElementById('btn-remove-source').addEventListener('click', async () => {
  if (!STATE.activeSourceId) { toast('Chọn một Source trước'); return; }
  try {
    await api.del('/api/sources/' + STATE.activeSourceId);
    STATE.activeSourceId = null;
    await loadSources(STATE.activeContainerId);
    toast('Đã xoá source');
  } catch(e) { toast('Lỗi: ' + e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// COLUMN 3 — Mindmap (D3 Force Graph)
// ═══════════════════════════════════════════════════════════════════

let simulation = null;

async function loadGraph(containerId) {
  try {
    const data = await api.get(`/api/containers/${containerId}/graph`);
    // Filter out dangling edges (source or target no longer exists)
    const nodeIds = new Set(data.nodes.map(n => n.node_id));
    data.edges = (data.edges || []).filter(
      e => nodeIds.has(e.source_node_id) && nodeIds.has(e.target_node_id)
    );
    STATE.graphData = data;
    renderGraph(data);
    document.getElementById('graph-empty').style.display = data.nodes.length ? 'none' : 'flex';
  } catch(e) {
    console.error('loadGraph error:', e);
    // Do NOT overwrite STATE.graphData on error
  }
}

function nodeColor(state) {
  const map = {
    EXPLORE:'#fbbf24', BUILD:'#38bdf8', ACTIVE:'#4ade80',
    STALE:'#fb923c', CONFLICTED:'#f87171', ARCHIVED:'#475569'
  };
  return map[state] || '#888';
}

function nodeFill(state) {
  const map = {
    EXPLORE:'#292010', BUILD:'#0c2030', ACTIVE:'#0c2010',
    STALE:'#281408', CONFLICTED:'#280808', ARCHIVED:'#181818'
  };
  return map[state] || '#1a1a1a';
}

// Pill width: dynamic based on title length, min 100, max 220
// Sub-nodes get a smaller pill: min 72, max 160
function nodeWidth(title, isSub) {
  if (isSub) return Math.min(Math.max((title || '').length * 4.5 + 14, 43), 96);
  return Math.min(Math.max((title || '').length * 5.4 + 19, 60), 132);
}
function nodeHeight(isSub) { return isSub ? 30 : 42; }

function renderGraph({ nodes, edges }) {
  const svg    = d3.select('#graph-svg');
  const root   = d3.select('#graph-root');
  const width  = document.getElementById('graph-container').clientWidth;
  const height = document.getElementById('graph-container').clientHeight;

  svg.attr('viewBox', `0 0 ${width} ${height}`);

  // ── Preserve existing node positions before clearing ──────────────
  root.selectAll('.g-node').each(function(d) {
    if (d && d.node_id) STATE.nodePositions.set(d.node_id, { x: d.x, y: d.y });
  });
  root.selectAll('*').remove();

  if (!nodes.length) return;

  // Assign positions: restored from cache or spread near center/neighbors
  const existingIds = new Set(STATE.nodePositions.keys());
  // Calculate centre of already-positioned nodes for anchoring new ones
  let posAnchorX = width / 2, posAnchorY = height / 2;
  const posNodes = nodes.filter(n => existingIds.has(n.node_id));
  if (posNodes.length > 0) {
    const sumX = posNodes.reduce((s, n) => s + STATE.nodePositions.get(n.node_id).x, 0);
    const sumY = posNodes.reduce((s, n) => s + STATE.nodePositions.get(n.node_id).y, 0);
    posAnchorX = sumX / posNodes.length;
    posAnchorY = sumY / posNodes.length;
  }
  let newNodeAngle = 0;
  nodes.forEach(n => {
    const pos = STATE.nodePositions.get(n.node_id);
    if (pos) {
      n.x = pos.x; n.y = pos.y;
    } else {
      // Spread new nodes in a ring around the anchor to avoid clustering
      const r   = 120 + Math.random() * 80;
      n.x = posAnchorX + r * Math.cos(newNodeAngle);
      n.y = posAnchorY + r * Math.sin(newNodeAngle);
      newNodeAngle += (2 * Math.PI) / Math.max((nodes.length - posNodes.length), 1);
    }
  });

  // Use low alpha if most nodes have known positions
  const knownRatio = posNodes.length / Math.max(nodes.length, 1);
  const startAlpha = knownRatio >= 0.5 ? 0.15 : 0.6;

  // Close edge context if the selected edge is gone
  const edgeIds = new Set(edges.map(e => e.edge_id));
  if (STATE.selectedEdgeId && !edgeIds.has(STATE.selectedEdgeId)) closeEdgeCtx();

  // Dismiss edge ctx on svg background click
  svg.on('click', () => closeEdgeCtx());

  // Zoom + pan
  svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => root.attr('transform', e.transform)));

  // Build id maps
  const nodeById = Object.fromEntries(nodes.map(n => [n.node_id, n]));

  // Links
  const linkData = edges.map(e => ({
    ...e,
    source: e.source_node_id,
    target: e.target_node_id,
  }));

  const linkG = root.append('g').attr('class', 'links');
  const linkSel = linkG.selectAll('.g-link').data(linkData).enter().append('g').attr('class', 'g-link')
    .classed('selected', d => d.edge_id === STATE.selectedEdgeId);

  // Visible path
  const paths = linkSel.append('path')
    .attr('fill', 'none')
    .attr('marker-end', 'url(#arrow)');

  // Invisible wide hit area
  const hitPaths = linkSel.append('path')
    .attr('class', 'link-hit')
    .attr('fill', 'none')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 14)
    .on('click', (e, d) => {
      e.stopPropagation();
      selectEdge(d, e.pageX, e.pageY);
    });

  const linkLabels = linkSel.append('text').text(d => d.relation_type.replace(/_/g,' '));

  // Nodes — mark sub-nodes (nodes that have at least one incoming edge from another node)
  const nodesWithIncoming = new Set(edges.map(e => e.target_node_id || e.target?.node_id || (typeof e.target === 'string' ? e.target : null)).filter(Boolean));
  const rootNodeIds = new Set(nodes.map(n => n.node_id).filter(id => !nodesWithIncoming.has(id)));

  const nodeG   = root.append('g').attr('class', 'nodes');
  const nodeSel = nodeG.selectAll('.g-node').data(nodes).enter().append('g')
    .attr('class', d => `g-node state-${d.state}${!rootNodeIds.has(d.node_id) ? ' sub-node' : ''}`)
    .attr('data-id', d => d.node_id)
    .call(d3.drag().on('start', dragStart).on('drag', dragged).on('end', dragEnd))
    .on('click', (e, d) => selectNode(d.node_id));

  nodeSel.append('rect')
    .attr('height', d => nodeHeight(!rootNodeIds.has(d.node_id)))
    .attr('rx', d => nodeHeight(!rootNodeIds.has(d.node_id)) / 2)
    .attr('ry', d => nodeHeight(!rootNodeIds.has(d.node_id)) / 2)
    .attr('width',  d => nodeWidth(d.title, !rootNodeIds.has(d.node_id)))
    .attr('x',      d => -nodeWidth(d.title, !rootNodeIds.has(d.node_id)) / 2)
    .attr('y',      d => -nodeHeight(!rootNodeIds.has(d.node_id)) / 2)
    .attr('fill',   d => nodeFill(d.state))
    .attr('stroke', d => nodeColor(d.state));

  // Title — centered in the pill
  nodeSel.append('text')
    .attr('dy', '-4')
    .attr('font-size', d => rootNodeIds.has(d.node_id) ? 9 : 8)
    .text(d => {
      const isSub = !rootNodeIds.has(d.node_id);
      const maxCh = Math.floor(nodeWidth(d.title, isSub) / (isSub ? 4.2 : 5.1));
      return d.title.length > maxCh ? d.title.slice(0, maxCh - 1) + '…' : d.title;
    });

  // Maturity stars — below the title
  nodeSel.append('text')
    .attr('dy', d => rootNodeIds.has(d.node_id) ? '7' : '6')
    .attr('font-size', d => rootNodeIds.has(d.node_id) ? 6 : 5)
    .attr('fill', '#94a3b8')
    .text(d => '★'.repeat(d.maturity_score) + '☆'.repeat(5 - d.maturity_score));

  // Highlight selected
  highlightSelectedNode();

  // Simulation — use startAlpha: low if positions restored, higher if mostly new nodes
  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(nodes)
    .alpha(startAlpha)
    .alphaDecay(startAlpha < 0.3 ? 0.06 : 0.03)   // decay faster when mostly settled
    .force('link',   d3.forceLink(linkData).id(d => d.node_id).distance(130))
    .force('charge', d3.forceManyBody().strength(-280))
    // Position forces target each node's saved position (prevents clustering on re-render)
    // For new nodes, fall back to current center
    .force('x', d3.forceX(d => {
      const p = STATE.nodePositions.get(d.node_id);
      return p ? p.x : posAnchorX;
    }).strength(d => STATE.nodePositions.has(d.node_id) ? 0.15 : 0.05))
    .force('y', d3.forceY(d => {
      const p = STATE.nodePositions.get(d.node_id);
      return p ? p.y : posAnchorY;
    }).strength(d => STATE.nodePositions.has(d.node_id) ? 0.15 : 0.05))
    .force('collide', d3.forceCollide(d => {
      const isSub = !rootNodeIds.has(d.node_id);
      return isSub ? 33 : 48;
    }))
    .on('tick', () => {
      // Save positions each tick so next render starts from latest positions
      nodes.forEach(n => STATE.nodePositions.set(n.node_id, { x: n.x, y: n.y }));
      const pathFn = d => {
        const sx = d.source.x, sy = d.source.y;
        const tx = clamp(d.target.x, 70, width - 70);
        const ty = clamp(d.target.y, 27, height - 27);
        // Trim path end so arrow tip lands on pill edge, not node center
        const ddx = tx - sx, ddy = ty - sy;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        const off = 23; // ≈ pill half-height + small gap
        const ex = tx - (ddx / dist) * off;
        const ey = ty - (ddy / dist) * off;
        // Cubic bezier with horizontal-bias control points
        const cpx = (ex - sx) * 0.45;
        return `M${sx},${sy} C${sx + cpx},${sy} ${ex - cpx},${ey} ${ex},${ey}`;
      };
      paths.attr('d', pathFn);
      hitPaths.attr('d', pathFn);
      linkLabels
        .attr('x', d => {
          const tx = clamp(d.target.x, 70, width - 70);
          return (d.source.x + tx) / 2;
        })
        .attr('y', d => {
          const ty = clamp(d.target.y, 27, height - 27);
          return (d.source.y + ty) / 2 - 6;
        });
      nodeSel.attr('transform', d => `translate(${clamp(d.x, 70, width - 70)},${clamp(d.y, 27, height - 27)})`);
    });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function dragStart(e, d) { if (!e.active && simulation) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
function dragged(e, d)    { d.fx = e.x; d.fy = e.y; }
function dragEnd(e, d)    { if (!e.active && simulation) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

function highlightSelectedNode() {
  d3.selectAll('.g-node').classed('selected', d => d.node_id === STATE.selectedNodeId);
  d3.selectAll('.g-node.selected rect').each(function(d) {
    d3.select(this).attr('stroke-width', 4);
  });
  d3.selectAll('.g-node:not(.selected) rect').each(function(d) {
    d3.select(this).attr('stroke-width', 2.5);
  });
}

async function selectNode(nodeId) {
  // Guard: chỉ load document nếu node vẫn tồn tại trong graphData hiện tại
  const exists = STATE.graphData.nodes.some(n => n.node_id === nodeId);
  if (!exists) return;
  saveChatState();  // save chat for the previously selected node
  STATE.selectedNodeId = nodeId;
  highlightSelectedNode();
  restoreChatState(`node:${nodeId}`);  // load chat history for this node
  // Auto-load document — không show error nếu node đã bị xoá
  await loadNodeDocument(nodeId, { silent: true });
}

// ── Add / Remove Node ─────────────────────────────────────────────

document.getElementById('btn-add-node').addEventListener('click', () => {
  if (!STATE.activeContainerId) { toast('Chọn Knowledge trước'); return; }
  document.getElementById('inp-node-title').value = '';
  openModal('modal-add-node');
});

document.getElementById('confirm-add-node').addEventListener('click', async () => {
  const title = document.getElementById('inp-node-title').value.trim();
  if (!title) { toast('Nhập tiêu đề node'); return; }
  try {
    const node = await api.post(`/api/containers/${STATE.activeContainerId}/nodes`, {
      container_id: STATE.activeContainerId,
      title,
      node_type: document.getElementById('inp-node-type').value,
      state: 'EXPLORE',
    });
    closeModal('modal-add-node');
    await loadGraph(STATE.activeContainerId);
    STATE.selectedNodeId = node.node_id;
    highlightSelectedNode();
    toast('Đã thêm node: ' + title);
    // Load document separately with its own error guard
    await loadNodeDocument(node.node_id);
  } catch(e) { toast('Lỗi tạo node: ' + e.message); }
});

document.getElementById('btn-remove-node').addEventListener('click', async () => {
  if (!STATE.selectedNodeId) { toast('Chọn một Node trước'); return; }
  const node = STATE.graphData.nodes.find(n => n.node_id === STATE.selectedNodeId);
  const name = node ? node.title : STATE.selectedNodeId;
  if (!confirm(`Xoá node "${name}" và các sub-node chỉ nối qua nó?`)) return;
  try {
    const r = await api.del(`/api/nodes/${STATE.selectedNodeId}?cascade=true`);
    // Xoá vị trí các node đã bị delete khỏi cache
    (r.deleted_ids || []).forEach(id => STATE.nodePositions.delete(id));
    toast(`Đã xoá ${r.deleted_ids.length} node`);
    STATE.selectedNodeId = null;
    clearDocumentPanel();
    clearChat();
    await loadGraph(STATE.activeContainerId);
  } catch(e) { toast('Lỗi: ' + e.message); }
});

// ── Document button ───────────────────────────────────────────────
document.getElementById('btn-open-document').addEventListener('click', async () => {
  if (!STATE.selectedNodeId) { toast('Chọn một Node trước'); return; }

  // Verify node có thực sự tồn tại bằng cách lấy fresh từ API
  let freshNode;
  try {
    const r = await api.get(`/api/nodes/${STATE.selectedNodeId}`);
    freshNode = r.node;
  } catch(e) {
    toast('Lỗi: node không tìm thấy');
    STATE.selectedNodeId = null;
    await loadGraph(STATE.activeContainerId);
    return;
  }

  const isExplore = freshNode.state === 'EXPLORE';

  if (isExplore) {
    toast('AI đang tạo tài liệu…');
    try {
      const capturedNodeId = STATE.selectedNodeId;
      const result = await api.post(`/api/nodes/${capturedNodeId}/auto-document`, {});
      // Refresh graphData trước khi render
      await loadGraph(STATE.activeContainerId);
      renderDocumentPanel(result.node, result.can_activate, result.missing_fields, result.edge_count || 0);
      if (result.suggested_nodes && result.suggested_nodes.length > 0) {
        STATE.pendingSuggested = result.suggested_nodes;
        renderSuggestedNodes(result.suggested_nodes, capturedNodeId);
        toast(`AI đã tạo tài liệu + ${result.suggested_nodes.length} gợi ý node liên quan`);
      } else {
        toast('AI đã tạo tài liệu thành công');
      }
    } catch (e) {
      toast('AI lỗi — dùng form thủ công: ' + e.message);
      await loadNodeDocument(STATE.selectedNodeId);
    }
  } else {
    await loadNodeDocument(STATE.selectedNodeId);
  }

  document.getElementById('panel-document').scrollIntoView({ behavior:'smooth' });
});

// ═══════════════════════════════════════════════════════════════════
// DOCUMENT PANEL
// ═══════════════════════════════════════════════════════════════════

function clearDocumentPanel() {
  document.getElementById('document-body').innerHTML = `
    <div class="panel-guide">
      <div class="guide-step">
        <div class="guide-num">1</div>
        <div class="guide-text"><strong>Chọn node</strong> trong Mindmap bằng cách click vào nó</div>
      </div>
      <div class="guide-step">
        <div class="guide-num">2</div>
        <div class="guide-text"><strong>Nhấn “Document”</strong> ở thanh dưới Mindmap</div>
      </div>
      <div class="guide-step">
        <div class="guide-num">3</div>
        <div class="guide-text"><strong>Điền các trường</strong> để xây dựng cấu trúc node:</div>
      </div>
      <ul class="guide-field-list">
        <li><strong>Definition</strong> <em>— Định nghĩa khái niệm</em></li>
        <li><strong>Mechanism</strong> <em>— Cơ chế hoạt động</em></li>
        <li><strong>Boundary</strong> <em>— Giới hạn áp dụng</em></li>
        <li><strong>Assumptions</strong> <em>— Giả định nền tảng</em></li>
      </ul>
      <div style="margin-top:8px;font-size:10px;color:#475569">
        ⚠ Cần đủ 3 trường trên để node được <strong style="color:#4ade80">ACTIVE</strong>
      </div>
    </div>`;
}

async function loadNodeDocument(nodeId, opts = {}) {
  try {
    // Guard: skip if node does not exist in current graphData
    if (STATE.graphData.nodes && !STATE.graphData.nodes.some(n => n.node_id === nodeId)) {
      if (!opts.silent) toast('Node không còn tồn tại trong graph');
      return;
    }
    const { node, can_activate, missing_fields, edge_count } = await api.get(`/api/nodes/${nodeId}`);
    renderDocumentPanel(node, can_activate, missing_fields, edge_count);
  } catch(e) {
    if (!opts.silent) toast('Không load được node: ' + e.message);
  }
}

function renderDocumentPanel(node, canActivate, missingFields, edgeCount) {
  const body = document.getElementById('document-body');

  // maturity pips
  const pips = Array.from({length:5}, (_,i) =>
    `<div class="maturity-pip ${i < node.maturity_score ? 'filled':''}"></div>`).join('');

  // missing fields warning
  const missingHtml = missingFields.length && node.state !== 'ACTIVE'
    ? `<div class="missing-fields">
        <strong>Cần điền để ACTIVATE:</strong>
        <ul>${missingFields.map(m=>`<li>${m}</li>`).join('')}</ul>
       </div>` : '';

  // ── Read-only view (tab 2) ────────────────────────────────────────
  const assumptionsReadHtml = (node.assumptions||[]).length
    ? `<ul class="read-assumptions">${(node.assumptions||[]).map(a=>`<li>${esc(a)}</li>`).join('')}</ul>`
    : `<div class="read-content empty">— chưa có —</div>`;

  const tagsReadHtml = (node.tags||[]).length
    ? `<div class="read-tags">${(node.tags||[]).map(t=>`<span class="read-tag">${esc(t)}</span>`).join('')}</div>`
    : '';

  const readHtml = `
<div class="read-view">
  <div class="read-meta">
    <span class="state-badge badge-${node.state}">${node.state}</span>
    <span>${node.node_type}</span>
    <div class="maturity-bar" style="display:inline-flex">${pips}<span style="font-size:10px;color:#64748b;margin-left:4px">${node.maturity_score}/5</span></div>
  </div>
  <div class="read-title">${esc(node.title)}</div>

  <div class="read-section">
    <div class="read-label">Định nghĩa</div>
    <div class="read-content ${node.definition?'':'empty'}">${node.definition ? esc(node.definition) : '— chưa có —'}</div>
  </div>
  <div class="read-section">
    <div class="read-label">Cơ chế hoạt động</div>
    <div class="read-content ${node.mechanism?'':'empty'}">${node.mechanism ? esc(node.mechanism) : '— chưa có —'}</div>
  </div>
  <div class="read-section">
    <div class="read-label">Điều kiện biên</div>
    <div class="read-content ${node.boundary_conditions?'':'empty'}">${node.boundary_conditions ? esc(node.boundary_conditions) : '— chưa có —'}</div>
  </div>
  <div class="read-section">
    <div class="read-label">Giả định</div>
    ${assumptionsReadHtml}
  </div>
  ${tagsReadHtml ? `<div class="read-section"><div class="read-label">Thẻ</div>${tagsReadHtml}</div>` : ''}
</div>`;

  // ── Input form (tab 1) ────────────────────────────────────────────
  const formHtml = `
<div class="doc-form" id="doc-form-${node.node_id}">

  <!-- header info -->
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px">
    <span class="state-badge badge-${node.state}">${node.state}</span>
    <div class="maturity-bar">${pips}<span style="font-size:10px;color:#64748b;margin-left:4px">${node.maturity_score}/5</span></div>
  </div>

  <div style="font-size:9px;color:#475569">ID: ${node.node_id} | v${node.version} | edges: ${edgeCount}</div>

  ${missingHtml}

  <div class="doc-field">
    <label>Title</label>
    <input id="df-title" value="${esc(node.title)}"/>
  </div>
  <div class="doc-field">
    <label>Node Type</label>
    <select id="df-type">${nodeTypeOptions(node.node_type)}</select>
  </div>
  <div class="doc-field">
    <label>Definition <span style="color:${node.definition?'#4ade80':'#f87171'}">●</span></label>
    <textarea id="df-definition" rows="3" placeholder="Định nghĩa khái niệm này là gì...">${esc(node.definition)}</textarea>
  </div>
  <div class="doc-field">
    <label>Mechanism <span style="color:${node.mechanism?'#4ade80':'#f87171'}">●</span></label>
    <textarea id="df-mechanism" rows="3" placeholder="Cơ chế hoạt động, nguyên lý...">${esc(node.mechanism)}</textarea>
  </div>
  <div class="doc-field">
    <label>Boundary Conditions <span style="color:${node.boundary_conditions?'#4ade80':'#f87171'}">●</span></label>
    <textarea id="df-boundary" rows="2" placeholder="Giới hạn, điều kiện áp dụng...">${esc(node.boundary_conditions)}</textarea>
  </div>
  <div class="doc-field">
    <label>Assumptions (mỗi dòng 1 giả định)</label>
    <textarea id="df-assumptions" rows="2" placeholder="Giả định 1\nGiả định 2...">${(node.assumptions||[]).join('\n')}</textarea>
  </div>
  <div class="doc-field">
    <label>Tags (cách nhau bởi dấu phẩy)</label>
    <input id="df-tags" value="${(node.tags||[]).join(', ')}"/>
  </div>
  <div class="doc-field">
    <label>State</label>
    <select id="df-state">${nodeStateOptions(node.state)}</select>
  </div>

  <div class="doc-actions">
    <button class="btn btn-add" onclick="saveDocument('${node.node_id}')">Lưu</button>
    ${canActivate
      ? `<button class="btn btn-doc" onclick="activateNode('${node.node_id}')">✓ Activate</button>`
      : `<button class="btn btn-rem" disabled title="${missingFields.join(', ')}">Activate (cần điền đủ)</button>`}
  </div>

  <!-- Link to existing node -->
  <div style="border-top:1px solid #1e293b;padding-top:8px;margin-top:4px">
    <div style="font-size:10px;color:#475569;margin-bottom:4px">Liên kết với node khác</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap">
      <select id="df-link-target" style="flex:1;font-size:11px;background:#1a1f2e;border:1px solid #2d3748;border-radius:4px;color:#e2e8f0;padding:4px">
        <option value="">— chọn node —</option>
        ${(STATE.graphData.nodes||[]).filter(n=>n.node_id!==node.node_id)
          .map(n=>`<option value="${n.node_id}">${n.title}</option>`).join('')}
      </select>
      <select id="df-link-rel" style="flex:1;font-size:11px;background:#1a1f2e;border:1px solid #2d3748;border-radius:4px;color:#e2e8f0;padding:4px">
        ${window._RELATION_TYPES.map(r=>`<option value="${r}">${r}</option>`).join('')}
      </select>
      <button class="btn btn-add" style="flex:0 0 50px;font-size:10px" onclick="linkToNode('${node.node_id}')">Link</button>
    </div>
  </div>
</div>`;

  // ── Combine into tabbed layout ────────────────────────────────────
  // Remember which tab was active
  const prevTab = body.querySelector('.doc-tab.active')?.dataset?.tab || 'input';
  body.innerHTML = `
<div class="doc-tabs-header">
  <button class="doc-tab ${prevTab==='input'?'active':''}" data-tab="input" onclick="switchDocTab('input')">Input Data</button>
  <button class="doc-tab ${prevTab==='read'?'active':''}"  data-tab="read"  onclick="switchDocTab('read')">Đọc Dữ Liệu</button>
</div>
<div id="doc-tab-input" class="doc-tab-pane" style="display:${prevTab==='input'?'':'none'}">${formHtml}</div>
<div id="doc-tab-read"  class="doc-tab-pane" style="display:${prevTab==='read' ?'':'none'}">${readHtml}</div>`;
}

window.switchDocTab = function(tab) {
  document.querySelectorAll('.doc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.doc-tab-pane').forEach(p => {
    p.style.display = p.id === `doc-tab-${tab}` ? '' : 'none';
  });
};

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function nodeTypeOptions(current) {
  return (window._NODE_TYPES||[]).map(t =>
    `<option value="${t}" ${t===current?'selected':''}>${t}</option>`).join('');
}

function nodeStateOptions(current) {
  return (window._NODE_STATES||[]).map(s =>
    `<option value="${s}" ${s===current?'selected':''}>${s}</option>`).join('');
}

window.saveDocument = async function(nodeId) {
  const assumptions = (document.getElementById('df-assumptions').value||'')
    .split('\n').map(s=>s.trim()).filter(Boolean);
  const tags = (document.getElementById('df-tags').value||'')
    .split(',').map(s=>s.trim()).filter(Boolean);

  const body = {
    title:             document.getElementById('df-title').value.trim(),
    node_type:         document.getElementById('df-type').value,
    definition:        document.getElementById('df-definition').value.trim(),
    mechanism:         document.getElementById('df-mechanism').value.trim(),
    boundary_conditions: document.getElementById('df-boundary').value.trim(),
    assumptions,
    tags,
    state:             document.getElementById('df-state').value,
  };

  try {
    const { node, can_activate, missing_fields, edge_count } = await api.patch(`/api/nodes/${nodeId}/document`, body);
    renderDocumentPanel(node, can_activate, missing_fields, edge_count || 0);
    await loadGraph(STATE.activeContainerId);
    toast('Đã lưu node: ' + node.title);
  } catch(e) { toast('Lỗi: ' + e.message); }
};

window.activateNode = async function(nodeId) {
  try {
    const { node, can_activate, missing_fields } = await api.patch(`/api/nodes/${nodeId}/document`, { state: 'ACTIVE' });
    renderDocumentPanel(node, can_activate, missing_fields, 0);
    await loadGraph(STATE.activeContainerId);
    toast('Node đã ACTIVE: ' + node.title);
  } catch(e) { toast('Lỗi: ' + e.message); }
};

window.linkToNode = async function(sourceNodeId) {
  const targetId = document.getElementById('df-link-target').value;
  const relType  = document.getElementById('df-link-rel').value;
  if (!targetId) { toast('Chọn node đích'); return; }
  try {
    const node = STATE.graphData.nodes.find(n => n.node_id === sourceNodeId);
    await api.post('/api/edges', {
      container_id:    STATE.activeContainerId,
      source_node_id:  sourceNodeId,
      target_node_id:  targetId,
      relation_type:   relType,
    });
    await loadGraph(STATE.activeContainerId);
    toast('Đã tạo edge');
  } catch(e) { toast('Lỗi: ' + e.message); }
};

// ═══════════════════════════════════════════════════════════════════
// EXPLORE PANEL
// ═══════════════════════════════════════════════════════════════════

function _chatKey() {
  if (STATE.selectedNodeId)    return `node:${STATE.selectedNodeId}`;
  if (STATE.activeContainerId) return `container:${STATE.activeContainerId}`;
  return null;
}

function saveChatState() {
  const key = _chatKey();
  if (key && STATE.chatHistory.length) {
    STATE.chatHistories.set(key, {
      messages: [...STATE.chatHistory],
      html: document.getElementById('chat-display').innerHTML,
    });
    _lsSave();
  }
}

function restoreChatState(key) {
  const saved = key ? STATE.chatHistories.get(key) : null;
  if (saved) {
    STATE.chatHistory = [...saved.messages];
    // If we have serialised html (same session) use it; otherwise rebuild from messages
    if (saved.html) {
      document.getElementById('chat-display').innerHTML = saved.html;
    } else {
      // Re-hydrate from messages only (cross-refresh case)
      const disp = document.getElementById('chat-display');
      disp.innerHTML = '';
      for (const m of saved.messages) {
        const el = document.createElement('div');
        el.className = `chat-msg ${m.role === 'user' ? 'user' : 'assistant'}`;
        el.textContent = m.content;
        disp.appendChild(el);
      }
    }
    setTimeout(() => {
      const d = document.getElementById('chat-display');
      d.scrollTop = d.scrollHeight;
    }, 0);
  } else {
    STATE.chatHistory = [];
    document.getElementById('chat-display').innerHTML = '';
  }
  STATE.pendingSuggested = [];
  document.getElementById('suggested-area').style.display = 'none';
}

function clearChat() {
  // Wipe history for current key and clear display
  const key = _chatKey();
  if (key) STATE.chatHistories.delete(key);
  STATE.chatHistory = [];
  STATE.pendingSuggested = [];
  document.getElementById('chat-display').innerHTML = '';
  document.getElementById('suggested-area').style.display = 'none';
  _lsSave();
}

window.clearChatHistory = function() {
  clearChat();
  toast('Đã xoá lịch sử chat');
};

// Mode toggle
document.querySelectorAll('input[name="explore-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.getElementById('mode-clarify-label').classList.toggle('active', radio.value==='clarify' && radio.checked);
    document.getElementById('mode-expand-label').classList.toggle('active',  radio.value==='expand' && radio.checked);
  });
});

function getExploreMode() {
  return document.querySelector('input[name="explore-mode"]:checked')?.value || 'clarify';
}

function addChatMsg(role, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  const disp = document.getElementById('chat-display');
  disp.appendChild(el);
  disp.scrollTop = disp.scrollHeight;
  return el;
}

async function sendExplore() {
  if (!STATE.selectedNodeId) { toast('Chọn một Node trước'); return; }
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';  // reset textarea height

  const mode = getExploreMode();
  addChatMsg('user', msg);
  const loadingEl = addChatMsg('loading', '...');
  STATE.chatHistory.push({ role: 'user', content: msg });

  try {
    const result = await api.post('/api/explore', {
      node_id:      STATE.selectedNodeId,
      container_id: STATE.activeContainerId,
      mode,
      message:      msg,
      history:      STATE.chatHistory.slice(-6),
    });

    loadingEl.classList.remove('loading');
    loadingEl.classList.add('assistant');

    // Structured block response (clarify mode with JSON)
    if (result.blocks && result.blocks.length) {
      loadingEl.classList.add('has-blocks');
      const summaryEl = document.createElement('div');
      summaryEl.className = 'res-summary';
      summaryEl.textContent = result.reply;
      loadingEl.appendChild(summaryEl);
      const blocksEl = renderBlockCards(result.blocks);
      loadingEl.appendChild(blocksEl);
      // Store summary + serialised blocks text in history
      const serialised = result.reply + '\n' +
        result.blocks.map(b => `[${b.type.toUpperCase()}] ${b.title}: ${b.content.join('; ')}`).join('\n');
      STATE.chatHistory.push({ role: 'assistant', content: serialised });
    } else {
      loadingEl.textContent = result.reply;
      STATE.chatHistory.push({ role: 'assistant', content: result.reply });
    }

    saveChatState();

    if (mode === 'expand' && result.suggested_nodes && result.suggested_nodes.length) {
      STATE.pendingSuggested = result.suggested_nodes;
      renderSuggestedNodes(result.suggested_nodes, STATE.selectedNodeId);
    }
  } catch(e) {
    loadingEl.classList.remove('loading');
    loadingEl.classList.add('assistant');
    loadingEl.textContent = 'Lỗi: ' + e.message;
  }
}

function renderBlockCards(blocks) {
  const container = document.createElement('div');
  container.className = 'res-blocks';

  // Build a fast lookup so we can highlight related blocks on click
  const blockEls = new Map(); // id → DOM element

  blocks.forEach(b => {
    const card = document.createElement('div');
    card.className = `res-block type-${b.type}`;
    card.dataset.bid = b.id;

    const header = document.createElement('div');
    header.className = 'res-block-header';

    const badge = document.createElement('span');
    badge.className = 'res-block-badge';
    badge.textContent = b.type;

    const title = document.createElement('span');
    title.className = 'res-block-title';
    title.textContent = b.title;

    header.appendChild(badge);
    header.appendChild(title);
    card.appendChild(header);

    const body = document.createElement('ul');
    body.className = 'res-block-body';
    (b.content || []).forEach(line => {
      const li = document.createElement('li');
      li.textContent = line;
      body.appendChild(li);
    });
    card.appendChild(body);

    // Toggle collapse on click + highlight related blocks
    card.addEventListener('click', () => {
      card.classList.toggle('collapsed');
      const related = [
        ...((b.relations && b.relations.depends_on) || []),
        ...((b.relations && b.relations.leads_to) || []),
      ];
      // Briefly highlight related
      blockEls.forEach((el, id) => el.classList.remove('highlighted'));
      related.forEach(id => blockEls.get(id)?.classList.add('highlighted'));
    });

    blockEls.set(b.id, card);
    container.appendChild(card);
  });

  return container;
}


function renderSuggestedNodes(parentNodeId, suggested) {
  const capturedParentId = parentNodeId || STATE.selectedNodeId;
  const area = document.getElementById('suggested-area');
  area.style.display = 'flex';
  area.innerHTML = `<div class="suggested-title">Node được đề xuất — chọn để thêm vào graph</div>`;

  suggested.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'suggest-item';
    row.innerHTML = `
      <input type="checkbox" id="sg-${i}" checked/>
      <span class="s-title">${esc(s.title)} <span style="color:#64748b;font-size:10px">[${s.node_type}]</span></span>
      <span class="s-rel">${s.relation_type}</span>`;
    area.appendChild(row);
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'suggest-confirm-btn';
  confirmBtn.textContent = 'Xác nhận thêm vào graph';
  confirmBtn.addEventListener('click', () => confirmSuggestedNodes(capturedParentId, suggested));
  area.appendChild(confirmBtn);
}

async function confirmSuggestedNodes(parentNodeId, suggestedList) {
  const nodeId = parentNodeId || STATE.selectedNodeId;
  if (!nodeId) { toast('Không có node cha được chọn'); return; }
  const items = suggestedList || STATE.pendingSuggested;
  const checks = document.querySelectorAll('#suggested-area input[type=checkbox]');
  const toAdd = items.filter((_, i) => checks[i]?.checked);
  if (!toAdd.length) { toast('Không có node nào được chọn'); return; }

  let added = 0;
  for (const s of toAdd) {
    try {
      const result = await api.post(`/api/nodes/${nodeId}/confirm-suggested`, {
        title:         s.title,
        node_type:     s.node_type,
        relation_type: s.relation_type,
        definition:    s.definition || '',
      });
      if (result.edge) added++;
      else { console.warn('Edge not returned for', s.title); added++; }
    } catch(e) { console.error(e); toast('Lỗi thêm node: ' + e.message); }
  }

  document.getElementById('suggested-area').style.display = 'none';
  STATE.pendingSuggested = [];
  await loadGraph(STATE.activeContainerId);
  toast(`Đã thêm ${added} node vào graph`);
}

document.getElementById('btn-send').addEventListener('click', sendExplore);
document.getElementById('chat-input').addEventListener('keydown', e => {
  // Shift+Enter = new line, Enter alone = send
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendExplore(); }
});
// Auto-resize textarea as user types
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CONTEXT  —  select / edit / delete edges
// ═══════════════════════════════════════════════════════════════════

function selectEdge(d, pageX, pageY) {
  STATE.selectedEdgeId = d.edge_id;
  // highlight
  d3.selectAll('.g-link').classed('selected', l => l.edge_id === d.edge_id);
  // populate select
  const sel = document.getElementById('edge-ctx-rel');
  sel.innerHTML = (window._RELATION_TYPES || []).map(r =>
    `<option value="${r}" ${r === d.relation_type ? 'selected' : ''}>${r.replace(/_/g,' ')}</option>`
  ).join('');
  // position + show
  const ctx = document.getElementById('edge-ctx');
  ctx.dataset.edgeId = d.edge_id;
  ctx.style.display  = 'block';
  ctx.style.left = Math.min(pageX + 10, window.innerWidth  - 230) + 'px';
  ctx.style.top  = Math.min(pageY - 20, window.innerHeight - 130) + 'px';
}

function closeEdgeCtx() {
  STATE.selectedEdgeId = null;
  d3.selectAll('.g-link').classed('selected', false);
  document.getElementById('edge-ctx').style.display = 'none';
}

window.saveEdge = async function() {
  const edgeId  = document.getElementById('edge-ctx').dataset.edgeId;
  const relType = document.getElementById('edge-ctx-rel').value;
  try {
    await api.patch('/api/edges/' + edgeId, { relation_type: relType });
    closeEdgeCtx();
    await loadGraph(STATE.activeContainerId);
    toast('Cập nhật liên kết thành công');
  } catch(e) { toast('Lỗi: ' + e.message); }
};

window.deleteEdge = async function() {
  const edgeId = document.getElementById('edge-ctx').dataset.edgeId;
  if (!confirm('Xóa liên kết này?')) return;
  try {
    await api.del('/api/edges/' + edgeId);
    closeEdgeCtx();
    await loadGraph(STATE.activeContainerId);
    toast('Đã xóa liên kết');
  } catch(e) { toast('Lỗi: ' + e.message); }
};

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

(function init() {
  console.log('[CGA] init() started — v8');
  // Expose enums from template (injected via Jinja) to JS
  // We read them from hidden data elements rendered server-side
  // They're passed via the page meta — we read from window vars set below
  const meta = document.querySelector('meta[name="app-data"]');
  if (meta) {
    try {
      const d = JSON.parse(meta.content);
      window._NODE_TYPES      = d.node_types;
      window._NODE_STATES     = d.node_states;
      window._RELATION_TYPES  = d.relation_types;
    } catch(_) {}
  }

  // Fallback defaults if meta not found
  if (!window._NODE_TYPES)     window._NODE_TYPES     = ['ONTOLOGY','MECHANISM','DOMAIN','ACTION','ASSUMPTION','CONTRADICTION','PREDICTION'];
  if (!window._NODE_STATES)    window._NODE_STATES    = ['EXPLORE','BUILD','ACTIVE','STALE','CONFLICTED','ARCHIVED'];
  if (!window._RELATION_TYPES) window._RELATION_TYPES = ['FOUNDATION_OF','INSTANCE_OF','REQUIRES','CAUSES','AMPLIFIES','INHIBITS','CONTRADICTS','EXAMPLE_OF','PART_OF','APPLIES_TO'];
  // ── Resize handle: Mindmap ↔ Right column (horizontal) ──────────
  (function initColResizeHandle() {
    const handle   = document.getElementById('col-resize-handle');
    const colMind  = document.querySelector('.col-mindmap');
    const colRight = document.querySelector('.col-right');
    if (!handle || !colMind || !colRight) return;

    let startX = 0, startMindW = 0, startRightW = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startX      = e.clientX;
      startMindW  = colMind.getBoundingClientRect().width;
      startRightW = colRight.getBoundingClientRect().width;
      handle.classList.add('dragging');

      function onMove(ev) {
        const dx       = ev.clientX - startX;
        const total    = startMindW + startRightW;
        const minMind  = 200;
        const minRight = 240;
        let newMind    = Math.max(minMind, Math.min(total - minRight, startMindW + dx));
        let newRight   = total - newMind;
        colMind.style.flex  = `0 0 ${newMind}px`;
        colRight.style.flex = `0 0 ${newRight}px`;
        // Re-render graph to fit new size
        if (STATE.activeContainerId && STATE.graphData.nodes.length) {
          renderGraph(STATE.graphData);
        }
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();
  // ── Resize handle between Document and Explore panels ───────────
  (function initResizeHandle() {
    const handle  = document.getElementById('panel-resize-handle');
    const panelDoc = document.getElementById('panel-document');
    const panelExp = document.getElementById('panel-explore');
    if (!handle || !panelDoc || !panelExp) return;

    let startY = 0, startDocH = 0, startExpH = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startY    = e.clientY;
      startDocH = panelDoc.getBoundingClientRect().height;
      startExpH = panelExp.getBoundingClientRect().height;
      handle.classList.add('dragging');

      function onMove(ev) {
        const dy    = ev.clientY - startY;
        const total = startDocH + startExpH;
        let newDoc  = Math.max(60, Math.min(total - 60, startDocH + dy));
        let newExp  = total - newDoc;
        panelDoc.style.flex = `0 0 ${newDoc}px`;
        panelExp.style.flex = `0 0 ${newExp}px`;
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // Initialise: load persisted chat histories, then load knowledge list
  console.log('[CGA] init() calling _lsLoad + loadKnowledge');
  _lsLoad();
  loadKnowledge();
  console.log('[CGA] init() done');
})();
