from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path

from pydantic import TypeAdapter

from .models import GraphEdge, GraphNode, KnowledgeContainer, Source


# ─────────────────────────────────────────────────────────────────────────────
# AbstractStorage — interface contract
# Swap FileStorage → PgStorage (Phase 3) mà không đụng routes.
# ─────────────────────────────────────────────────────────────────────────────

class AbstractStorage(ABC):
    # Containers
    @abstractmethod
    def list_containers(self) -> list[KnowledgeContainer]: ...
    @abstractmethod
    def get_container(self, container_id: str) -> KnowledgeContainer | None: ...
    @abstractmethod
    def upsert_container(self, c: KnowledgeContainer) -> None: ...
    @abstractmethod
    def delete_container(self, container_id: str) -> None: ...

    # Sources
    @abstractmethod
    def list_sources(self, container_id: str) -> list[Source]: ...
    @abstractmethod
    def upsert_source(self, s: Source) -> None: ...
    @abstractmethod
    def delete_source(self, source_id: str) -> None: ...

    # Nodes
    @abstractmethod
    def list_nodes(self, container_id: str) -> list[GraphNode]: ...
    @abstractmethod
    def get_node(self, node_id: str) -> GraphNode | None: ...
    @abstractmethod
    def upsert_node(self, node: GraphNode) -> None: ...
    @abstractmethod
    def delete_node(self, node_id: str) -> None: ...
    @abstractmethod
    def delete_node_cascade(self, node_id: str) -> list[str]: ...

    # Edges
    @abstractmethod
    def list_edges(self, container_id: str) -> list[GraphEdge]: ...
    @abstractmethod
    def get_edge(self, edge_id: str) -> GraphEdge | None: ...
    @abstractmethod
    def upsert_edge(self, edge: GraphEdge) -> None: ...
    @abstractmethod
    def delete_edge(self, edge_id: str) -> None: ...


class FileStorage(AbstractStorage):
    """JSONL-based file storage.  One file per entity type.
    Strategy: append-only; latest record by ID wins on read.
    Deletions tracked via a tombstone set stored in a sidecar file.
    """

    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self._dir = data_dir

        self._containers_path  = data_dir / "containers.jsonl"
        self._sources_path     = data_dir / "sources.jsonl"
        self._nodes_path       = data_dir / "nodes.jsonl"
        self._edges_path       = data_dir / "edges.jsonl"
        self._deleted_path     = data_dir / "deleted_ids.json"

        self._ta_container = TypeAdapter(KnowledgeContainer)
        self._ta_source    = TypeAdapter(Source)
        self._ta_node      = TypeAdapter(GraphNode)
        self._ta_edge      = TypeAdapter(GraphEdge)

        self._deleted: set[str] = self._load_deleted()

    # ── internal helpers ──────────────────────────────────────────────────

    def _load_deleted(self) -> set[str]:
        if self._deleted_path.exists():
            return set(json.loads(self._deleted_path.read_text(encoding="utf-8")))
        return set()

    def _save_deleted(self) -> None:
        self._deleted_path.write_text(
            json.dumps(list(self._deleted), ensure_ascii=False),
            encoding="utf-8",
        )

    def _read_jsonl(self, path: Path) -> list[dict]:
        if not path.exists():
            return []
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
        return rows

    def _append(self, path: Path, obj: dict) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")

    def _latest_by_id(self, rows: list[dict], id_field: str) -> dict[str, dict]:
        """Return the most recent record per ID (last write wins)."""
        out: dict[str, dict] = {}
        for r in rows:
            out[r[id_field]] = r
        return out

    def _live(self, records: dict[str, dict]) -> list[dict]:
        """Filter out deleted IDs."""
        return [v for k, v in records.items() if k not in self._deleted]

    # ── CONTAINERS ────────────────────────────────────────────────────────

    def list_containers(self) -> list[KnowledgeContainer]:
        rows = self._latest_by_id(self._read_jsonl(self._containers_path), "container_id")
        live = self._live(rows)
        result = [self._ta_container.validate_python(r) for r in live]
        return sorted(result, key=lambda c: c.created_at)

    def upsert_container(self, c: KnowledgeContainer) -> None:
        self._append(self._containers_path, c.model_dump(mode="json"))

    def get_container(self, container_id: str) -> KnowledgeContainer | None:
        rows = self._latest_by_id(self._read_jsonl(self._containers_path), "container_id")
        r = rows.get(container_id)
        if r and container_id not in self._deleted:
            return self._ta_container.validate_python(r)
        return None

    def delete_container(self, container_id: str) -> None:
        self._deleted.add(container_id)
        # Also tombstone all children
        for s in self.list_sources(container_id):
            self._deleted.add(s.source_id)
        for n in self.list_nodes(container_id):
            self._deleted.add(n.node_id)
        for e in self.list_edges(container_id):
            self._deleted.add(e.edge_id)
        self._save_deleted()

    # ── SOURCES ───────────────────────────────────────────────────────────

    def list_sources(self, container_id: str) -> list[Source]:
        rows = self._latest_by_id(self._read_jsonl(self._sources_path), "source_id")
        live = [self._ta_source.validate_python(v) for v in self._live(rows)]
        return sorted([s for s in live if s.container_id == container_id], key=lambda s: s.created_at)

    def upsert_source(self, s: Source) -> None:
        self._append(self._sources_path, s.model_dump(mode="json"))

    def delete_source(self, source_id: str) -> None:
        self._deleted.add(source_id)
        self._save_deleted()

    # ── NODES ─────────────────────────────────────────────────────────────

    def list_nodes(self, container_id: str) -> list[GraphNode]:
        rows = self._latest_by_id(self._read_jsonl(self._nodes_path), "node_id")
        live = [self._ta_node.validate_python(v) for v in self._live(rows)]
        return sorted([n for n in live if n.container_id == container_id], key=lambda n: n.created_at)

    def get_node(self, node_id: str) -> GraphNode | None:
        rows = self._latest_by_id(self._read_jsonl(self._nodes_path), "node_id")
        r = rows.get(node_id)
        if r and node_id not in self._deleted:
            return self._ta_node.validate_python(r)
        return None

    def upsert_node(self, node: GraphNode) -> None:
        self._append(self._nodes_path, node.model_dump(mode="json"))

    def delete_node(self, node_id: str) -> None:
        """Delete node + all its edges."""
        # Collect edges BEFORE marking as deleted (get_node checks _deleted)
        node = self.get_node(node_id)
        if node:
            edges = self.list_edges(node.container_id)
            for e in edges:
                if e.source_node_id == node_id or e.target_node_id == node_id:
                    self._deleted.add(e.edge_id)
        self._deleted.add(node_id)
        self._save_deleted()

    def delete_node_cascade(self, node_id: str) -> list[str]:
        """Delete node and all purely-downstream nodes (only 1 incoming edge from this node).
        Returns list of all deleted node_ids."""
        node = self.get_node(node_id)
        if not node:
            return []

        all_nodes = self.list_nodes(node.container_id)
        all_edges = self.list_edges(node.container_id)

        # Build incoming edge count per node
        incoming: dict[str, list[str]] = {n.node_id: [] for n in all_nodes}
        for e in all_edges:
            if e.target_node_id in incoming:
                incoming[e.target_node_id].append(e.source_node_id)

        # BFS from node_id following outgoing edges
        to_delete: list[str] = []
        queue = [node_id]
        visited: set[str] = set()

        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            to_delete.append(current)

            # Find children via outgoing edges
            children = [e.target_node_id for e in all_edges if e.source_node_id == current]
            for child in children:
                # Only cascade-delete if this node is the ONLY parent
                parents = incoming.get(child, [])
                if len(parents) == 1 and parents[0] == current:
                    queue.append(child)

        for nid in to_delete:
            self.delete_node(nid)

        return to_delete

    # ── EDGES ─────────────────────────────────────────────────────────────

    def list_edges(self, container_id: str) -> list[GraphEdge]:
        rows = self._latest_by_id(self._read_jsonl(self._edges_path), "edge_id")
        live = [self._ta_edge.validate_python(v) for v in self._live(rows)]
        return [e for e in live if e.container_id == container_id]

    def get_edge(self, edge_id: str) -> GraphEdge | None:
        rows = self._latest_by_id(self._read_jsonl(self._edges_path), "edge_id")
        r = rows.get(edge_id)
        if r and edge_id not in self._deleted:
            return self._ta_edge.validate_python(r)
        return None

    def upsert_edge(self, edge: GraphEdge) -> None:
        self._append(self._edges_path, edge.model_dump(mode="json"))

    def delete_edge(self, edge_id: str) -> None:
        self._deleted.add(edge_id)
        self._save_deleted()
