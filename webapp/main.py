from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.requests import Request
from starlette.responses import Response

load_dotenv()

from rks.agent import CognitiveAgent
from rks.models import (
    ContainerCreate,
    EdgeCreate,
    ExploreRequest,
    GraphEdge,
    GraphNode,
    KnowledgeContainer,
    NodeCreate,
    NodeDocument,
    NodeState,
    NodeType,
    RelationType,
    Source,
    SourceCreate,
    SourceType,
)
from rks.storage import FileStorage


class _ContainerUpdate(BaseModel):
    title: str
    description: str = ""


def create_app() -> FastAPI:
    app = FastAPI(title="Cognitive Graph Agent v1.0")

    # ── HTTP Basic Auth ────────────────────────────────────────────────
    # Chỉ bật khi APP_PASSWORD được set trong .env / environment.
    # Khi chạy local không có APP_PASSWORD → bỏ qua, không cần đăng nhập.
    _pwd = os.environ.get("APP_PASSWORD", "").strip()
    if _pwd:
        _usr = os.environ.get("APP_USERNAME", "admin").strip()

        @app.middleware("http")
        async def _basic_auth(request: Request, call_next):
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Basic "):
                try:
                    decoded = base64.b64decode(auth[6:]).decode("utf-8", errors="replace")
                    user, _, pwd = decoded.partition(":")
                    ok = secrets.compare_digest(user, _usr) and secrets.compare_digest(pwd, _pwd)
                    if ok:
                        request.state.username = user   # ← Phase 2: lưu username
                        return await call_next(request)
                except Exception:
                    pass
            return Response(
                content="401 Unauthorised — Cognitive Graph Agent",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="Cognitive Graph Agent"'},
            )

    base_dir  = Path(__file__).resolve().parent
    data_base = base_dir.parent / "data"

    templates = Jinja2Templates(directory=str(base_dir / "templates"))
    app.mount("/static", StaticFiles(directory=str(base_dir / "static")), name="static")

    # ── Per-user dependency chain ──────────────────────────────────────────
    # get_current_user → get_storage → get_agent
    # Mỗi request tự động nhận đúng storage của user đang đăng nhập.

    def get_current_user(request: Request) -> str:
        """Trả về username từ Basic Auth header hoặc 'default' (local mode)."""
        return getattr(request.state, "username", "default")

    def get_storage(user: str = Depends(get_current_user)) -> FileStorage:
        """Tạo FileStorage trỏ vào data/users/{username}/ — mỗi user cách ly hoàn toàn."""
        return FileStorage(data_dir=data_base / "users" / user)

    def get_agent(storage: FileStorage = Depends(get_storage)) -> CognitiveAgent:
        return CognitiveAgent(storage=storage)

    # ────────────────────────────────────────────────────────────
    # MAIN PAGE
    # ────────────────────────────────────────────────────────────

    @app.get("/", response_class=HTMLResponse)
    def index(request: Request):
        return templates.TemplateResponse("index.html", {
            "request": request,
            "node_types": [t.value for t in NodeType],
            "node_states": [s.value for s in NodeState],
            "relation_types": [r.value for r in RelationType],
            "source_types": [s.value for s in SourceType],
        })

    # ────────────────────────────────────────────────────────────
    # KNOWLEDGE CONTAINERS
    # ────────────────────────────────────────────────────────────

    @app.get("/api/containers")
    def list_containers(storage: FileStorage = Depends(get_storage)):
        return storage.list_containers()

    @app.post("/api/containers", status_code=201)
    def create_container(body: ContainerCreate,
                         storage: FileStorage = Depends(get_storage),
                         user: str = Depends(get_current_user)):
        c = KnowledgeContainer(user_id=user, title=body.title.strip(), description=body.description.strip())
        storage.upsert_container(c)
        return c

    @app.delete("/api/containers/{container_id}")
    def delete_container(container_id: str, storage: FileStorage = Depends(get_storage)):
        c = storage.get_container(container_id)
        if not c:
            raise HTTPException(404, "Container not found")
        storage.delete_container(container_id)
        return {"ok": True}

    @app.patch("/api/containers/{container_id}")
    def update_container(container_id: str, body: _ContainerUpdate,
                         storage: FileStorage = Depends(get_storage)):
        c = storage.get_container(container_id)
        if not c:
            raise HTTPException(404, "Container not found")
        c.title = body.title.strip()
        if body.description:
            c.description = body.description.strip()
        storage.upsert_container(c)
        return c

    # ────────────────────────────────────────────────────────────
    # SOURCES
    # ────────────────────────────────────────────────────────────

    @app.get("/api/containers/{container_id}/sources")
    def list_sources(container_id: str, storage: FileStorage = Depends(get_storage)):
        return storage.list_sources(container_id)

    @app.post("/api/containers/{container_id}/sources", status_code=201)
    def create_source(container_id: str, body: SourceCreate,
                      storage: FileStorage = Depends(get_storage)):
        if not storage.get_container(container_id):
            raise HTTPException(404, "Container not found")
        s = Source(
            container_id=container_id,
            type=body.type,
            label=body.label.strip(),
            path_or_url=body.path_or_url.strip(),
            notes=body.notes.strip(),
        )
        storage.upsert_source(s)
        return s

    @app.delete("/api/sources/{source_id}")
    def delete_source(source_id: str, storage: FileStorage = Depends(get_storage)):
        storage.delete_source(source_id)
        return {"ok": True}

    # ────────────────────────────────────────────────────────────
    # GRAPH NODES
    # ────────────────────────────────────────────────────────────

    @app.get("/api/containers/{container_id}/graph")
    def get_graph(container_id: str, storage: FileStorage = Depends(get_storage)):
        """Trả về toàn bộ nodes + edges của container (cho Mindmap)."""
        if not storage.get_container(container_id):
            raise HTTPException(404, "Container not found")
        nodes = storage.list_nodes(container_id)
        edges = storage.list_edges(container_id)
        return {"nodes": nodes, "edges": edges}

    @app.post("/api/containers/{container_id}/nodes", status_code=201)
    def create_node(container_id: str, body: NodeCreate,
                    storage: FileStorage = Depends(get_storage)):
        if not storage.get_container(container_id):
            raise HTTPException(404, "Container not found")
        node = GraphNode(
            container_id=container_id,
            title=body.title.strip(),
            node_type=body.node_type,
            state=body.state,
        )
        storage.upsert_node(node)
        return node

    @app.get("/api/nodes/{node_id}")
    def get_node(node_id: str,
                 storage: FileStorage = Depends(get_storage),
                 agent: CognitiveAgent = Depends(get_agent)):
        node = storage.get_node(node_id)
        if not node:
            raise HTTPException(404, "Node not found")
        ok, missing = agent.can_activate(node)
        edges = storage.list_edges(node.container_id)
        connected_edges = [e for e in edges if e.source_node_id == node_id or e.target_node_id == node_id]
        return {
            "node": node,
            "can_activate": ok,
            "missing_fields": missing,
            "edge_count": len(connected_edges),
        }

    @app.patch("/api/nodes/{node_id}/document")
    def update_node_document(node_id: str, body: NodeDocument,
                             storage: FileStorage = Depends(get_storage),
                             agent: CognitiveAgent = Depends(get_agent)):
        try:
            node = agent.update_node_document(node_id, body)
        except KeyError:
            raise HTTPException(404, "Node not found")
        ok, missing = agent.can_activate(node)
        edges = storage.list_edges(node.container_id)
        edge_count = sum(1 for e in edges if e.source_node_id == node_id or e.target_node_id == node_id)
        return {
            "node": node,
            "can_activate": ok,
            "missing_fields": missing,
            "edge_count": edge_count,
        }

    @app.delete("/api/nodes/{node_id}")
    def delete_node(node_id: str, cascade: bool = True,
                    storage: FileStorage = Depends(get_storage)):
        node = storage.get_node(node_id)
        if not node:
            raise HTTPException(404, "Node not found")
        if cascade:
            deleted_ids = storage.delete_node_cascade(node_id)
            return {"ok": True, "deleted_ids": deleted_ids}
        else:
            storage.delete_node(node_id)
            return {"ok": True, "deleted_ids": [node_id]}

    # ────────────────────────────────────────────────────────────
    # EDGES
    # ────────────────────────────────────────────────────────────

    @app.post("/api/edges", status_code=201)
    def create_edge(body: EdgeCreate,
                    storage: FileStorage = Depends(get_storage),
                    agent: CognitiveAgent = Depends(get_agent)):
        src = storage.get_node(body.source_node_id)
        tgt = storage.get_node(body.target_node_id)
        if not src or not tgt:
            raise HTTPException(404, "Source or target node not found")
        edge = agent.create_edge(body)
        return edge

    @app.patch("/api/edges/{edge_id}")
    def update_edge(edge_id: str, body: dict,
                    storage: FileStorage = Depends(get_storage)):
        edge = storage.get_edge(edge_id)
        if not edge:
            raise HTTPException(404, "Edge not found")
        if "relation_type" in body:
            try:
                edge.relation_type = RelationType(body["relation_type"])
            except ValueError:
                raise HTTPException(422, f"Invalid relation_type: {body['relation_type']}")
        storage.upsert_edge(edge)
        return edge

    @app.delete("/api/edges/{edge_id}")
    def delete_edge(edge_id: str, storage: FileStorage = Depends(get_storage)):
        storage.delete_edge(edge_id)
        return {"ok": True}

    # ────────────────────────────────────────────────────────────
    # EXPLORE (AI Chat)
    # ────────────────────────────────────────────────────────────

    @app.post("/api/explore")
    def explore(body: ExploreRequest,
                agent: CognitiveAgent = Depends(get_agent)):
        return agent.explore(body)

    @app.post("/api/nodes/{node_id}/auto-document")
    def auto_document(node_id: str,
                      storage: FileStorage = Depends(get_storage),
                      agent: CognitiveAgent = Depends(get_agent)):
        """AI tự động điền definition/mechanism/boundary/assumptions."""
        try:
            result = agent.auto_document_node(node_id)
        except KeyError:
            raise HTTPException(404, "Node not found")
        node = result["node"]
        ok, missing = agent.can_activate(node)
        edges = storage.list_edges(node.container_id)
        edge_count = sum(1 for e in edges if e.source_node_id == node_id or e.target_node_id == node_id)
        return {
            "node": node,
            "can_activate": ok,
            "missing_fields": missing,
            "edge_count": edge_count,
            "suggested_nodes": result["suggested_nodes"],
        }

    # ────────────────────────────────────────────────────────────
    # CONFIRM SUGGESTED NODE (từ Explore Expand mode)
    # ────────────────────────────────────────────────────────────

    @app.post("/api/nodes/{node_id}/confirm-suggested", status_code=201)
    def confirm_suggested(node_id: str, body: dict,
                          storage: FileStorage = Depends(get_storage)):
        """Tạo node mới từ AI suggestion và tạo edge nối về node gốc."""
        parent = storage.get_node(node_id)
        if not parent:
            raise HTTPException(404, "Parent node not found")

        new_node = GraphNode(
            container_id=parent.container_id,
            title=body.get("title", "").strip(),
            node_type=NodeType(body.get("node_type", NodeType.ONTOLOGY)),
            state=NodeState.EXPLORE,
            definition=body.get("definition", ""),
            source_type="LLM_GENERATED",
        )
        storage.upsert_node(new_node)

        edge = GraphEdge(
            container_id=parent.container_id,
            source_node_id=new_node.node_id,
            target_node_id=node_id,
            relation_type=RelationType(body.get("relation_type", RelationType.PART_OF)),
        )
        storage.upsert_edge(edge)

        return {"node": new_node, "edge": edge}

    return app


app = create_app()
