from __future__ import annotations

import json
import os
import re

from .models import (
    EdgeCreate,
    ExploreRequest,
    ExploreResponse,
    GraphEdge,
    GraphNode,
    NodeDocument,
    NodeState,
    NodeType,
    RelationType,
    ResponseBlock,
    SuggestedNode,
)
from .storage import FileStorage


class CognitiveAgent:
    def __init__(self, storage: FileStorage):
        self.storage = storage
        self._llm_client = None
        self._model = "gpt-4o-mini"
        self._init_llm()

    def _init_llm(self) -> None:
        """Khởi tạo LLM client nếu có API key."""
        api_key = os.getenv("OPENAI_API_KEY", "")
        if api_key:
            try:
                from openai import OpenAI
                self._llm_client = OpenAI(api_key=api_key)
            except ImportError:
                pass

    # ── Node maturity ──────────────────────────────────────────────────────

    def compute_maturity(self, node: GraphNode) -> int:
        score = 0
        if node.definition.strip():          score += 1
        if node.mechanism.strip():           score += 1
        if node.boundary_conditions.strip(): score += 1
        if len(node.assumptions) >= 1:       score += 1
        # Check if it has ≥3 edges
        edges = self.storage.list_edges(node.container_id)
        connected = [e for e in edges if e.source_node_id == node.node_id or e.target_node_id == node.node_id]
        if len(connected) >= 3:              score = max(score, 3)
        return score

    def can_activate(self, node: GraphNode) -> tuple[bool, list[str]]:
        """Kiểm tra node đủ điều kiện ACTIVE chưa."""
        missing = []
        if not node.definition.strip():
            missing.append("Thiếu Definition")
        if not node.mechanism.strip():
            missing.append("Thiếu Mechanism")
        if not node.boundary_conditions.strip():
            missing.append("Thiếu Boundary Conditions")
        return len(missing) == 0, missing

    # ── Document update ────────────────────────────────────────────────────

    def update_node_document(self, node_id: str, doc: NodeDocument) -> GraphNode:
        node = self.storage.get_node(node_id)
        if node is None:
            raise KeyError(f"Node not found: {node_id}")

        data = doc.model_dump(exclude_unset=True)
        for k, v in data.items():
            setattr(node, k, v)

        # Nếu user muốn ACTIVE → validate
        if node.state == NodeState.ACTIVE:
            ok, _ = self.can_activate(node)
            if not ok:
                node.state = NodeState.BUILD

        # Nếu có ít nhất definition → thăng Build
        if node.state == NodeState.EXPLORE and node.definition.strip():
            node.state = NodeState.BUILD

        node.touch()
        node.maturity_score = self.compute_maturity(node)
        node.version += 1
        self.storage.upsert_node(node)
        return node

    # ── Edge creation ──────────────────────────────────────────────────────

    def create_edge(self, req: EdgeCreate) -> GraphEdge:
        edge = GraphEdge(
            container_id=req.container_id,
            source_node_id=req.source_node_id,
            target_node_id=req.target_node_id,
            relation_type=req.relation_type,
            weight=req.weight,
            condition=req.condition,
        )
        self.storage.upsert_edge(edge)
        return edge

    # ── Explore (AI chat) ──────────────────────────────────────────────────

    def explore(self, req: ExploreRequest) -> ExploreResponse:
        node = self.storage.get_node(req.node_id)
        if node is None:
            return ExploreResponse(reply="Node không tồn tại.")

        if self._llm_client:
            return self._explore_with_llm(req, node)
        else:
            return self._explore_mock(req, node)

    def _build_system_prompt(self, node: GraphNode, mode: str) -> str:
        base = f"""Bạn là trợ lý giúp xây dựng Knowledge Graph.
Node hiện tại:
- Title: {node.title}
- Type: {node.node_type}
- Definition: {node.definition or '(chưa có)'}
- Mechanism: {node.mechanism or '(chưa có)'}
- Boundary: {node.boundary_conditions or '(chưa có)'}

"""
        if mode == "clarify":
            return base + """Mode: CLARIFY — 3-Tầng Reasoning

Trước khi trả lời, hãy suy luận qua 3 tầng (KHÔNG viết tầng này ra ngoài JSON):

TẦNG 1 — PROBLEM REASONING: Câu hỏi thuộc loại nào?
  • khái niệm / so sánh / nguyên nhân-hệ quả / hướng dẫn hành động
  • Mức trừu tượng: cơ bản / trung cấp / chuyên sâu
  • Người dùng cần: hiểu / quyết định / áp dụng

TẦNG 2 — KNOWLEDGE REASONING: Những mảnh kiến thức nào thực sự cần?
  • Xác định khái niệm cốt lõi
  • Phân biệt: nguyên nhân / cơ chế / hệ quả
  • Loại bỏ kiến thức thừa không liên quan

TẦNG 3 — STRUCTURE/PRESENTATION: Sắp xếp blocks theo logic phù hợp
  • axis: overview_to_detail | cause_effect | comparison | action_guide
  • Mỗi block = 1 ý, 2-4 câu, có quan hệ rõ với block khác

YÊU CẦU NGHIÊM NGẶT:
- Chỉ trả về JSON hợp lệ, KHÔNG viết text tự do bên ngoài JSON.
- Số blocks: 3-6, đủ sâu, không dư thừa.
- block.type chọn từ: definition | mechanism | cause | consequence | principle | comparison | example | action
- Phải có ít nhất 1 block loại mechanism hoặc cause nếu câu hỏi có tính nhân-quả.

JSON Schema bắt buộc:
{
  "summary": "string — tóm tắt trực tiếp câu hỏi trong 1 câu",
  "axis": "overview_to_detail | cause_effect | comparison | action_guide",
  "blocks": [
    {
      "id": "b1",
      "type": "definition | mechanism | cause | consequence | principle | comparison | example | action",
      "title": "string",
      "content": ["string", "string"],
      "relations": { "depends_on": ["b_id"], "leads_to": ["b_id"] }
    }
  ]
}"""
        else:
            relation_types = [r.value for r in RelationType]
            node_types = [t.value for t in NodeType]
            return base + f"""Mode: EXPAND
Nhiệm vụ: Đề xuất các khái niệm liên quan để mở rộng graph.
- Đề xuất 2-4 nodes mới có liên quan
- Chỉ rõ relation_type cho mỗi node (từ danh sách: {', '.join(relation_types)})
- Chỉ rõ node_type (từ danh sách: {', '.join(node_types)})

Sau câu trả lời, thêm JSON block theo đúng format:
```json
[
  {{"title": "...", "node_type": "...", "relation_type": "...", "definition": "..."}}
]
```"""

    def _explore_with_llm(self, req: ExploreRequest, node: GraphNode) -> ExploreResponse:
        messages = [{"role": "system", "content": self._build_system_prompt(node, req.mode)}]
        for m in req.history[-6:]:  # max 6 turns context
            messages.append({"role": m.role, "content": m.content})
        messages.append({"role": "user", "content": req.message})

        try:
            resp = self._llm_client.chat.completions.create(
                model=self._model,
                messages=messages,
                temperature=0.7,
                max_tokens=2000,
            )
            reply = resp.choices[0].message.content or ""

            if req.mode == "clarify":
                # Try to parse structured JSON response
                try:
                    raw = re.sub(r"```json|```", "", reply).strip()
                    data = json.loads(raw)
                    if "blocks" in data:
                        blocks = [
                            ResponseBlock(
                                id=b.get("id", f"b{i}"),
                                type=b.get("type", "definition"),
                                title=b.get("title", ""),
                                content=b.get("content", []),
                                relations=b.get("relations", {}),
                            )
                            for i, b in enumerate(data["blocks"])
                        ]
                        return ExploreResponse(
                            reply=data.get("summary", ""),
                            blocks=blocks,
                        )
                except Exception:
                    pass
                return ExploreResponse(reply=reply)

            # expand mode
            suggested = self._parse_suggested_nodes(reply)
            clean_reply = re.sub(r"```json.*?```", "", reply, flags=re.DOTALL).strip()
            return ExploreResponse(reply=clean_reply, suggested_nodes=suggested)
        except Exception as e:
            return ExploreResponse(reply=f"Lỗi LLM: {e}")

    # ── Auto-Document (AI fills definition/mechanism/boundary + suggests nodes) ──

    def auto_document_node(self, node_id: str) -> dict:
        """
        Tự động điền Document fields + đề xuất related nodes bằng LLM.
        Trả về { node, suggested_nodes }.
        """
        node = self.storage.get_node(node_id)
        if node is None:
            raise KeyError(f"Node not found: {node_id}")

        if self._llm_client:
            return self._auto_document_with_llm(node)
        else:
            return self._auto_document_mock(node)

    def _auto_document_with_llm(self, node: GraphNode) -> dict:
        relation_types = [r.value for r in RelationType]
        node_types     = [t.value for t in NodeType]
        prompt = f"""Bạn là chuyên gia tri thức. Hãy tạo tài liệu chi tiết cho khái niệm sau:

Khái niệm: "{node.title}"
Loại node: {node.node_type}
Container: (domain không xác định — hãy suy diễn từ tên)

Nhiệm vụ:
1. Viết definition ngắn gọn (2-3 câu) bằng tiếng Việt
2. Viết mechanism — cơ chế hoạt động / nguyên lý (3-5 câu)
3. Viết boundary_conditions — giới hạn phạm vi áp dụng (2-3 câu)
4. Liệt kê 2-3 assumptions — giả định nền tảng (mỗi giả định 1 dòng)
5. Đề xuất 3-4 nodes liên quan để mở rộng graph

Trả lời theo JSON sau (CHỈ JSON, không thêm text):
{{
  "definition": "...",
  "mechanism": "...",
  "boundary_conditions": "...",
  "assumptions": ["...", "..."],
  "suggested_nodes": [
    {{"title": "...", "node_type": "<một trong: {', '.join(node_types)}>", "relation_type": "<một trong: {', '.join(relation_types)}>", "definition": "..."}}
  ]
}}"""

        try:
            resp = self._llm_client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=1200,
                response_format={"type": "json_object"},
            )
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
        except Exception as e:
            return self._auto_document_mock(node, error=str(e))

        # Apply parsed fields to node
        if data.get("definition"):        node.definition          = data["definition"]
        if data.get("mechanism"):         node.mechanism           = data["mechanism"]
        if data.get("boundary_conditions"): node.boundary_conditions = data["boundary_conditions"]
        if data.get("assumptions"):       node.assumptions         = [a for a in data["assumptions"] if a.strip()]

        if node.state == NodeState.EXPLORE and node.definition.strip():
            node.state = NodeState.BUILD
        node.touch()
        node.maturity_score = self.compute_maturity(node)
        node.version += 1
        self.storage.upsert_node(node)

        # Parse suggested
        suggested = []
        for item in (data.get("suggested_nodes") or []):
            try:
                nt = NodeType(item.get("node_type", "ONTOLOGY"))
            except ValueError:
                nt = NodeType.ONTOLOGY
            try:
                rt = RelationType(item.get("relation_type", "PART_OF"))
            except ValueError:
                rt = RelationType.PART_OF
            suggested.append(SuggestedNode(
                title=item.get("title", ""),
                node_type=nt,
                relation_type=rt,
                definition=item.get("definition", ""),
            ))

        return {"node": node, "suggested_nodes": suggested}

    def _auto_document_mock(self, node: GraphNode, error: str = "") -> dict:
        """Fallback khi không có API key hoặc LLM lỗi."""
        prefix = f"[DEMO - {'Lỗi LLM: ' + error if error else 'không có API key'}]\n\n"
        node.definition = prefix + f"{node.title} là một khái niệm quan trọng cần được định nghĩa rõ ràng."
        node.mechanism  = prefix + "Cơ chế hoạt động cần được phân tích và mô tả chi tiết."
        node.boundary_conditions = prefix + "Phạm vi áp dụng còn cần được xác định."
        node.assumptions = ["Giả định 1 (demo)", "Giả định 2 (demo)"]
        if node.state == NodeState.EXPLORE:
            node.state = NodeState.BUILD
        node.touch()
        node.maturity_score = self.compute_maturity(node)
        node.version += 1
        self.storage.upsert_node(node)
        suggested = [
            SuggestedNode(
                title=f"{node.title} — Ví dụ",
                node_type=NodeType.DOMAIN,
                relation_type=RelationType.PART_OF,
                definition="(demo node)",
            ),
            SuggestedNode(
                title=f"Cơ chế của {node.title}",
                node_type=NodeType.MECHANISM,
                relation_type=RelationType.FOUNDATION_OF,
                definition="(demo node)",
            ),
        ]
        return {"node": node, "suggested_nodes": suggested}

    def _explore_mock(self, req: ExploreRequest, node: GraphNode) -> ExploreResponse:
        """Fallback khi không có LLM API key."""
        if req.mode == "clarify":
            reply = (
                f"[Demo — không có API key]\n\n"
                f"Node **{node.title}** hiện đang ở trạng thái {node.state.value}.\n"
                f"{'Đã có definition.' if node.definition else 'Chưa có definition — hãy điền vào Document panel.'}\n"
                f"{'Đã có mechanism.' if node.mechanism else 'Chưa có mechanism.'}\n\n"
                f"Để Explore thực sự hoạt động, hãy set OPENAI_API_KEY trong file .env"
            )
            return ExploreResponse(reply=reply)
        else:
            suggested = [
                SuggestedNode(
                    title=f"{node.title} — Ví dụ 1",
                    node_type=NodeType.INSTANCE_OF if hasattr(NodeType, "INSTANCE_OF") else NodeType.DOMAIN,
                    relation_type=RelationType.PART_OF,
                    definition="(AI demo node — cần API key để expand thật sự)",
                ),
                SuggestedNode(
                    title=f"Cơ chế của {node.title}",
                    node_type=NodeType.MECHANISM,
                    relation_type=RelationType.FOUNDATION_OF,
                    definition="(AI demo node)",
                ),
            ]
            reply = (
                f"[Demo — không có API key]\n\n"
                f"Gợi ý 2 nodes mở rộng từ **{node.title}** (demo).\n"
                f"Set OPENAI_API_KEY trong .env để dùng AI thật."
            )
            return ExploreResponse(reply=reply, suggested_nodes=suggested)

    def _parse_suggested_nodes(self, text: str) -> list[SuggestedNode]:
        """Parse JSON block từ LLM response."""
        match = re.search(r"```json\s*(.*?)```", text, re.DOTALL)
        if not match:
            return []
        try:
            items = json.loads(match.group(1))
            result = []
            for item in items:
                try:
                    node_type = NodeType(item.get("node_type", "ONTOLOGY"))
                except ValueError:
                    node_type = NodeType.ONTOLOGY
                try:
                    rel_type = RelationType(item.get("relation_type", "PART_OF"))
                except ValueError:
                    rel_type = RelationType.PART_OF
                result.append(SuggestedNode(
                    title=item.get("title", ""),
                    node_type=node_type,
                    relation_type=rel_type,
                    definition=item.get("definition", ""),
                ))
            return result
        except Exception:
            return []
