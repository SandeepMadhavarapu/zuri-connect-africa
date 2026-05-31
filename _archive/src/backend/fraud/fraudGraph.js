/**
 * Zuri Connect Africa - fraud graph intelligence
 * Tracks entity relationships across devices, phones, merchants, IPs,
 * transactions, auth failures, and scam reports.
 */

const GRAPH_KEY = 'zuri_fraud_graph_v1';
const MAX_EVENTS = 1500;
const MAX_EDGES = 3000;

export const FRAUD_ENTITY = {
  DEVICE: 'device',
  PHONE: 'phone',
  RECIPIENT: 'recipient',
  MERCHANT: 'merchant',
  IP: 'ip',
  TX: 'transaction',
  AUTH_FAILURE: 'auth_failure',
  SCAM_REPORT: 'scam_report',
};

function readGraph() {
  try {
    return JSON.parse(localStorage.getItem(GRAPH_KEY) || '{"nodes":{},"edges":[],"events":[]}');
  } catch {
    return { nodes: {}, edges: [], events: [] };
  }
}

function writeGraph(graph) {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify(graph));
  } catch {
    // Production storage would be server-side graph persistence.
  }
}

function entityId(type, value) {
  return `${type}:${String(value || 'unknown').trim().toLowerCase()}`;
}

function addNode(graph, type, value, metadata = {}) {
  const id = entityId(type, value);
  const now = Date.now();
  const existing = graph.nodes[id] || {
    id,
    type,
    value: String(value || 'unknown'),
    firstSeenAt: now,
    riskScore: 0,
    flags: [],
    metadata: {},
    degree: 0,
  };

  graph.nodes[id] = {
    ...existing,
    lastSeenAt: now,
    seenCount: (existing.seenCount || 0) + 1,
    metadata: { ...existing.metadata, ...metadata },
  };
  return graph.nodes[id];
}

function addEdge(graph, from, to, relation, weight = 1, metadata = {}) {
  if (!from?.id || !to?.id || from.id === to.id) return null;

  const existing = graph.edges.find(edge =>
    edge.from === from.id && edge.to === to.id && edge.relation === relation
  );

  if (existing) {
    existing.weight += weight;
    existing.lastSeenAt = Date.now();
    existing.count = (existing.count || 1) + 1;
    existing.metadata = { ...existing.metadata, ...metadata };
    return existing;
  }

  const edge = {
    id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from: from.id,
    to: to.id,
    relation,
    weight,
    count: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    metadata,
  };
  graph.edges.push(edge);
  graph.nodes[from.id].degree = (graph.nodes[from.id].degree || 0) + 1;
  graph.nodes[to.id].degree = (graph.nodes[to.id].degree || 0) + 1;
  return edge;
}

function trimGraph(graph) {
  if (graph.events.length > MAX_EVENTS) {
    graph.events.splice(0, graph.events.length - MAX_EVENTS);
  }
  if (graph.edges.length > MAX_EDGES) {
    graph.edges.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    graph.edges = graph.edges.slice(0, MAX_EDGES);
  }
}

export function recordFraudGraphEvent({
  txRef,
  deviceId,
  phone,
  recipient,
  merchant,
  ip,
  authFailure,
  scamReport,
  amount = 0,
  risk = 0,
  metadata = {},
} = {}) {
  const graph = readGraph();
  const primary = [];

  if (txRef) primary.push(addNode(graph, FRAUD_ENTITY.TX, txRef, { amount }));
  if (deviceId) primary.push(addNode(graph, FRAUD_ENTITY.DEVICE, deviceId));
  if (phone) primary.push(addNode(graph, FRAUD_ENTITY.PHONE, phone));
  if (recipient) primary.push(addNode(graph, FRAUD_ENTITY.RECIPIENT, recipient));
  if (merchant) primary.push(addNode(graph, FRAUD_ENTITY.MERCHANT, merchant));
  if (ip) primary.push(addNode(graph, FRAUD_ENTITY.IP, ip));
  if (authFailure) primary.push(addNode(graph, FRAUD_ENTITY.AUTH_FAILURE, authFailure));
  if (scamReport) primary.push(addNode(graph, FRAUD_ENTITY.SCAM_REPORT, scamReport));

  const txNode = txRef ? graph.nodes[entityId(FRAUD_ENTITY.TX, txRef)] : primary[0];
  primary.forEach(node => {
    if (node && txNode && node.id !== txNode.id) addEdge(graph, txNode, node, 'observed_with', 1, { amount });
  });

  const suspiciousNodes = primary.filter(Boolean);
  suspiciousNodes.forEach(node => {
    node.riskScore = Math.min(100, Math.max(node.riskScore || 0, risk));
    if (risk >= 70 && !node.flags.includes('high_risk_cluster_contact')) {
      node.flags.push('high_risk_cluster_contact');
    }
  });

  graph.events.push({
    id: `fg_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    txRef,
    entities: suspiciousNodes.map(node => node.id),
    risk,
    amount,
    metadata,
    createdAt: Date.now(),
  });

  propagateGraphRisk(graph);
  trimGraph(graph);
  writeGraph(graph);
  return analyzeFraudGraph();
}

export function propagateGraphRisk(graph = readGraph()) {
  const nodes = graph.nodes;
  graph.edges.forEach(edge => {
    const from = nodes[edge.from];
    const to = nodes[edge.to];
    if (!from || !to) return;

    const propagated = Math.round((from.riskScore || 0) * Math.min(0.35, edge.weight * 0.04));
    if (propagated > (to.riskScore || 0)) {
      to.riskScore = Math.min(100, propagated);
      if (!to.flags.includes('propagated_risk')) to.flags.push('propagated_risk');
    }
  });
  writeGraph(graph);
  return graph;
}

export function analyzeFraudGraph() {
  const graph = readGraph();
  const nodes = Object.values(graph.nodes);
  const highRiskNodes = nodes.filter(node => (node.riskScore || 0) >= 70 || (node.degree || 0) >= 8);
  const muleAccounts = nodes.filter(node =>
    [FRAUD_ENTITY.RECIPIENT, FRAUD_ENTITY.PHONE].includes(node.type) &&
    (node.degree || 0) >= 5 &&
    (node.riskScore || 0) >= 45
  );
  const scamClusters = highRiskNodes
    .filter(node => (node.degree || 0) >= 3)
    .map(node => ({
      nodeId: node.id,
      type: node.type,
      value: node.value,
      degree: node.degree || 0,
      riskScore: node.riskScore || 0,
      flags: node.flags || [],
    }))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 25);

  return {
    nodeCount: nodes.length,
    edgeCount: graph.edges.length,
    eventCount: graph.events.length,
    highRiskNodeCount: highRiskNodes.length,
    muleAccounts,
    scamClusters,
    campaignScore: Math.min(100, highRiskNodes.length * 8 + muleAccounts.length * 10),
    updatedAt: Date.now(),
  };
}

export function getFraudGraphSnapshot() {
  return {
    graph: readGraph(),
    analysis: analyzeFraudGraph(),
  };
}

export function resetFraudGraph() {
  const empty = { nodes: {}, edges: [], events: [] };
  writeGraph(empty);
  return empty;
}
