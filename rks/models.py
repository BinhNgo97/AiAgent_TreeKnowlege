from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────
# ENUMS
# ─────────────────────────────────────────────

class NodeState(str, Enum):
    EXPLORE    = "EXPLORE"
    BUILD      = "BUILD"
    ACTIVE     = "ACTIVE"
    STALE      = "STALE"
    CONFLICTED = "CONFLICTED"
    ARCHIVED   = "ARCHIVED"


class NodeType(str, Enum):
    ONTOLOGY      = "ONTOLOGY"
    MECHANISM     = "MECHANISM"
    DOMAIN        = "DOMAIN"
    ACTION        = "ACTION"
    ASSUMPTION    = "ASSUMPTION"
    CONTRADICTION = "CONTRADICTION"
    PREDICTION    = "PREDICTION"


class RelationType(str, Enum):
    FOUNDATION_OF = "FOUNDATION_OF"
    INSTANCE_OF   = "INSTANCE_OF"
    REQUIRES      = "REQUIRES"
    CAUSES        = "CAUSES"
    AMPLIFIES     = "AMPLIFIES"
    INHIBITS      = "INHIBITS"
    CONTRADICTS   = "CONTRADICTS"
    EXAMPLE_OF    = "EXAMPLE_OF"
    PART_OF       = "PART_OF"
    APPLIES_TO    = "APPLIES_TO"


class SourceType(str, Enum):
    PDF  = "PDF"
    URL  = "URL"
    TEXT = "TEXT"


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────

def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


# ─────────────────────────────────────────────
# KNOWLEDGE CONTAINER  (Cột 1 — Knowledge)
# ─────────────────────────────────────────────

class KnowledgeContainer(BaseModel):
    container_id: str = Field(default_factory=lambda: _uid("KC"))
    user_id: str = "default"          # Phase 2: per-user isolation
    title: str
    description: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ContainerCreate(BaseModel):
    title: str
    description: str = ""


# ─────────────────────────────────────────────
# SOURCE  (Cột 2 — Source)
# ─────────────────────────────────────────────

class Source(BaseModel):
    source_id: str = Field(default_factory=lambda: _uid("SRC"))
    container_id: str
    type: SourceType = SourceType.TEXT
    label: str                        # tên hiển thị (tên file / URL / tiêu đề)
    path_or_url: str = ""             # đường dẫn file hoặc URL
    notes: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SourceCreate(BaseModel):
    container_id: str
    type: SourceType = SourceType.TEXT
    label: str
    path_or_url: str = ""
    notes: str = ""


# ─────────────────────────────────────────────
# GRAPH NODE  (Cột 3 — Mindmap)
# ─────────────────────────────────────────────

class GraphNode(BaseModel):
    node_id: str = Field(default_factory=lambda: _uid("N"))
    container_id: str

    title: str
    node_type: NodeType = NodeType.ONTOLOGY
    state: NodeState = NodeState.EXPLORE

    # Document fields — điền trong Document Panel
    definition: str = ""
    mechanism: str = ""
    boundary_conditions: str = ""
    assumptions: list[str] = Field(default_factory=list)

    # Meta
    maturity_score: int = 0          # 0–5 auto-computed
    source_type: str = "ASSERTED"    # DERIVED | OBSERVED | ASSERTED | LLM_GENERATED
    tags: list[str] = Field(default_factory=list)
    version: int = 1

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    def touch(self) -> None:
        self.updated_at = datetime.utcnow()

    def compute_maturity(self) -> int:
        score = 0
        if self.definition:             score += 1   # 1: có definition
        if self.mechanism:              score += 1   # 2: có mechanism
        if self.boundary_conditions:    score += 1   # 3: có boundary
        if len(self.assumptions) >= 1:  score += 1   # 4: có assumptions
        return score                                  # 5 = survived reflection (set externally)


class NodeCreate(BaseModel):
    container_id: str
    title: str
    node_type: NodeType = NodeType.ONTOLOGY
    state: NodeState = NodeState.EXPLORE


class NodeDocument(BaseModel):
    """Payload để lưu Document Panel content."""
    title: str | None = None
    node_type: NodeType | None = None
    definition: str | None = None
    mechanism: str | None = None
    boundary_conditions: str | None = None
    assumptions: list[str] | None = None
    tags: list[str] | None = None
    state: NodeState | None = None


# ─────────────────────────────────────────────
# GRAPH EDGE
# ─────────────────────────────────────────────

class GraphEdge(BaseModel):
    edge_id: str = Field(default_factory=lambda: _uid("E"))
    container_id: str
    source_node_id: str
    target_node_id: str
    relation_type: RelationType = RelationType.PART_OF
    weight: float = 1.0
    condition: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EdgeCreate(BaseModel):
    container_id: str
    source_node_id: str
    target_node_id: str
    relation_type: RelationType = RelationType.PART_OF
    weight: float = 1.0
    condition: str = ""


# ─────────────────────────────────────────────
# EXPLORE SESSION (Hỏi đáp AI)
# ─────────────────────────────────────────────

class ExploreMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class ExploreRequest(BaseModel):
    node_id: str
    container_id: str
    mode: str = "clarify"      # "clarify" | "expand"
    message: str
    history: list[ExploreMessage] = Field(default_factory=list)


class SuggestedNode(BaseModel):
    title: str
    node_type: NodeType
    relation_type: RelationType
    definition: str = ""


class ResponseBlock(BaseModel):
    id: str
    type: str   # definition | mechanism | consequence | example
    title: str
    content: list[str] = Field(default_factory=list)
    relations: dict = Field(default_factory=dict)


class ExploreResponse(BaseModel):
    reply: str
    suggested_nodes: list[SuggestedNode] = Field(default_factory=list)
    blocks: list[ResponseBlock] = Field(default_factory=list)
