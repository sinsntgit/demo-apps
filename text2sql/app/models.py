from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, now

ROLES = ("admin", "steward", "analyst")   # steward = curates training data, sees dashboard
ISSUE_TYPES = {"wrong_numbers": "The numbers are wrong", "missing": "Something is missing",
               "extra": "It includes things that should not be there", "filter": "Wrong period or filter",
               "grouping": "Wrong breakdown or grouping", "misunderstood": "It answered a different question",
               "other": "Something else"}


class Company(Base):
    """A tenant. Every user belongs to exactly one company and only ever sees that company's data."""
    __tablename__ = "companies"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)        # False: its users cannot sign in
    default_model_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    default_sender_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    hidden_models: Mapped[list] = mapped_column(JSON, default=list)      # shared platform models switched off here
    hidden_senders: Mapped[list] = mapped_column(JSON, default=list)
    logo_file: Mapped[str] = mapped_column(String(100), default="")          # in DATA_DIR/logos; shown in the menu and PDFs
    pptx_template: Mapped[str] = mapped_column(String(255), default="")      # original file name; stored as DATA_DIR/templates/<id>.pptx
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)   # manages companies + shared models/senders
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="analyst")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_secret_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_counter: Mapped[int] = mapped_column(Integer, default=0)   # replay protection
    recovery_codes: Mapped[list] = mapped_column(JSON, default=list)     # hashes
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)       # bump = revoke sessions
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    # analysts only: False = sees results only (no SQL, no Python code). None (older rows) = sees everything
    show_sql: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, default=True)


class Connection(Base):
    """A data model: one database (or file folder) plus its own training data."""
    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_connections_company_name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    db_type: Mapped[str] = mapped_column(String(30))
    config_enc: Mapped[str] = mapped_column(Text)                 # encrypted JSON incl. password
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    restricted: Mapped[bool] = mapped_column(Boolean, default=False)   # only granted users
    allow_samples: Mapped[bool] = mapped_column(Boolean, default=False)
    sample_columns: Mapped[list] = mapped_column(JSON, default=list)   # ["table.column"]
    masked_columns: Mapped[list] = mapped_column(JSON, default=list)   # name patterns
    schema_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    schema_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
    graph_signature: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)   # schema + verified SQL the graph was built from


class ConnectionAccess(Base):
    __tablename__ = "connection_access"
    __table_args__ = (UniqueConstraint("connection_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class ConnectionGroupAccess(Base):
    """A user group that may use a restricted data model."""
    __tablename__ = "connection_group_access"
    __table_args__ = (UniqueConstraint("connection_id", "group_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int] = mapped_column(Integer, index=True)


class TrainingItem(Base):
    __tablename__ = "training_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)     # ddl | documentation | sql_pair | document
    title: Mapped[str] = mapped_column(String(500), default="")
    content: Mapped[str] = mapped_column(Text, default="")        # ddl / doc text / chunk text
    question: Mapped[str] = mapped_column(Text, default="")       # sql_pair
    sql: Mapped[str] = mapped_column(Text, default="")            # sql_pair
    source: Mapped[str] = mapped_column(String(30), default="manual")  # manual|upload|import|confirmed|correction
    status: Mapped[str] = mapped_column(String(20), default="approved", index=True)  # approved|pending|rejected
    document_name: Mapped[str] = mapped_column(String(500), default="")
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class LLMModel(Base):
    __tablename__ = "llm_models"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_llm_models_company_name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)   # None = platform model
    share_all: Mapped[bool] = mapped_column(Boolean, default=False)          # platform model: every company may use it
    shared_companies: Mapped[list] = mapped_column(JSON, default=list)      # ...or only these companies
    name: Mapped[str] = mapped_column(String(255))   # display name
    provider: Mapped[str] = mapped_column(String(30))             # anthropic | openai | openai_compatible
    model_id: Mapped[str] = mapped_column(String(255))
    base_url: Mapped[str] = mapped_column(String(500), default="")
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    effort: Mapped[str] = mapped_column(String(20), default="")   # anthropic effort; blank = model default
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    price_in: Mapped[float] = mapped_column(Float, default=0.0)   # $ per million input tokens
    price_out: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(500), default="New chat")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    runs: Mapped[list["QueryRun"]] = relationship(back_populates="conversation", cascade="all, delete-orphan",
                                                  order_by="QueryRun.id")


class QueryRun(Base):
    """One question -> SQL -> result. Doubles as the chat message and the audit record."""
    __tablename__ = "query_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    model_id: Mapped[Optional[int]] = mapped_column(ForeignKey("llm_models.id", ondelete="SET NULL"), nullable=True)
    model_label: Mapped[str] = mapped_column(String(255), default="")
    question: Mapped[str] = mapped_column(Text)
    generated_sql: Mapped[str] = mapped_column(Text, default="")  # what the model wrote
    final_sql: Mapped[str] = mapped_column(Text, default="")      # what was executed (may be user-edited)
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    explanation: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    # pending_review | success | error | clarification | blocked
    error: Mapped[str] = mapped_column(Text, default="")
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    columns: Mapped[list] = mapped_column(JSON, default=list)     # [{name, type}]
    result_rows: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    summary: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    chart: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)   # user's chosen view
    followups: Mapped[list] = mapped_column(JSON, default=list)
    feedback: Mapped[str] = mapped_column(String(20), default="")  # '' | correct | corrected | incorrect
    feedback_note: Mapped[str] = mapped_column(Text, default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    llm_ms: Mapped[int] = mapped_column(Integer, default=0)
    db_ms: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)      # model calls incl. repairs
    context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # what was sent to the model
    analysis: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # predictive: {"spec", "result" | "error"}
    # combined data models: {"steps": [{id, source, sql, rows, ms, filters, columns}], "combine", "generated": <the model's plan>}
    plan: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    rephrase_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)   # asked using this rephrased wording
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    # "these results are incorrect" -> review queue -> training
    issue_type: Mapped[str] = mapped_column(String(30), default="")       # see ISSUE_TYPES
    issue_status: Mapped[str] = mapped_column(String(20), default="")     # '' | open | fixed | noted | dismissed
    issue_resolution: Mapped[str] = mapped_column(Text, default="")       # the steward's answer, shown to the user
    issue_resolved_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    issue_resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    conversation: Mapped[Conversation] = relationship(back_populates="runs")


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)   # None = platform event
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    user_email: Mapped[str] = mapped_column(String(255), default="")
    action: Mapped[str] = mapped_column(String(100), index=True)
    target: Mapped[str] = mapped_column(String(500), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)   # {"v": ...}


class DataFilter(Base):
    """Row-level filter: a condition on one table, applied to every query a user runs."""
    __tablename__ = "data_filters"
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    table_name: Mapped[str] = mapped_column(String(255))
    condition: Mapped[str] = mapped_column(Text)                       # SQL boolean expression on that table
    scope: Mapped[str] = mapped_column(String(10), default="all")      # all | role | group | user
    role: Mapped[str] = mapped_column(String(20), default="")
    group_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), default="Untitled report")
    description: Mapped[str] = mapped_column(Text, default="")
    header_text: Mapped[str] = mapped_column(String(300), default="")
    footer_text: Mapped[str] = mapped_column(String(300), default="")
    page_numbers: Mapped[bool] = mapped_column(Boolean, default=True)
    components: Mapped[list] = mapped_column(JSON, default=list)
    schedule: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)   # UTC
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class ReportShare(Base):
    __tablename__ = "report_shares"
    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(10))                     # user | role | group
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="")
    group_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)     # scope == "group"
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)


class ReportSnapshot(Base):
    """A dated PDF produced by a schedule (or on demand), rendered with the owner's access."""
    __tablename__ = "report_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    trigger: Mapped[str] = mapped_column(String(20), default="schedule")   # schedule | manual
    status: Mapped[str] = mapped_column(String(20), default="ok")          # ok | error
    file_name: Mapped[str] = mapped_column(String(300), default="")
    emailed_to: Mapped[list] = mapped_column(JSON, default=list)
    note: Mapped[str] = mapped_column(Text, default="")


class UserGroup(Base):
    __tablename__ = "user_groups"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_user_groups_company_name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class UserGroupMember(Base):
    __tablename__ = "user_group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("user_groups.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class EmailSender(Base):
    """A mailbox the platform sends from (scheduled reports)."""
    __tablename__ = "email_senders"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)   # None = platform sender
    share_all: Mapped[bool] = mapped_column(Boolean, default=False)
    shared_companies: Mapped[list] = mapped_column(JSON, default=list)
    label: Mapped[str] = mapped_column(String(200))
    from_name: Mapped[str] = mapped_column(String(200), default="")
    from_email: Mapped[str] = mapped_column(String(255))
    reply_to: Mapped[str] = mapped_column(String(255), default="")
    mode: Mapped[str] = mapped_column(String(20), default="smtp")        # smtp | simulate
    host: Mapped[str] = mapped_column(String(255), default="")
    port: Mapped[int] = mapped_column(Integer, default=587)
    secure: Mapped[bool] = mapped_column(Boolean, default=False)         # SSL/TLS from the start (port 465)
    username: Mapped[str] = mapped_column(String(255), default="")
    password_enc: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    last_error: Mapped[str] = mapped_column(Text, default="")
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class EmailLog(Base):
    __tablename__ = "email_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    sender_label: Mapped[str] = mapped_column(String(200), default="")
    to_addr: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(20))                      # sent | failed | simulated
    error: Mapped[str] = mapped_column(Text, default="")
    context: Mapped[str] = mapped_column(String(200), default="")        # e.g. "report: Monthly sales"


class ConversationShare(Base):
    """A chat shared by its owner with a person, a role or a user group, to view or to add questions."""
    __tablename__ = "conversation_shares"
    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(10))                     # user | role | group
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="")
    group_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)     # scope == "group"
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)


class RephraseLog(Base):
    """One press of "Rephrase": the wording asked for, what the model suggested, and what it cost."""
    __tablename__ = "rephrase_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    model_id: Mapped[Optional[int]] = mapped_column(ForeignKey("llm_models.id", ondelete="SET NULL"), nullable=True)
    model_label: Mapped[str] = mapped_column(String(255), default="")
    question: Mapped[str] = mapped_column(Text)
    rephrased: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="ok")         # ok | error
    error: Mapped[str] = mapped_column(Text, default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    llm_ms: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)            # a question was then asked with it
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


# ---- metadata graph: names, keys and relationships only - never row data (app/graph.py) -------------------------------
class GraphEntity(Base):
    """A business thing (Customer, Invoice, Material) with the words people use for it."""
    __tablename__ = "graph_entities"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    synonyms: Mapped[list] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class GraphBinding(Base):
    """Where an entity is stored: one table of one data model, with its key columns."""
    __tablename__ = "graph_bindings"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    entity_id: Mapped[int] = mapped_column(ForeignKey("graph_entities.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    table_name: Mapped[str] = mapped_column(String(255))
    key_columns: Mapped[list] = mapped_column(JSON, default=list)
    source_of_truth: Mapped[bool] = mapped_column(Boolean, default=False)


class GraphEdge(Base):
    """One way to join two tables. Within one data model both sides have the same connection_id.
    status: suggested (never used until confirmed) | confirmed | rejected (remembered, not suggested again)."""
    __tablename__ = "graph_edges"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    left_connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    left_table: Mapped[str] = mapped_column(String(255))
    left_columns: Mapped[list] = mapped_column(JSON, default=list)
    right_connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    right_table: Mapped[str] = mapped_column(String(255))
    right_columns: Mapped[list] = mapped_column(JSON, default=list)
    kind: Mapped[str] = mapped_column(String(10), default="join")            # fk | join | match
    cardinality: Mapped[str] = mapped_column(String(5), default="")          # '' (unknown) | 1:1 | 1:N | N:1  (left : right)
    normalisation: Mapped[str] = mapped_column(String(30), default="")       # cross-source key rule (phase 2)
    origin: Mapped[str] = mapped_column(String(20), default="steward")       # schema | verified_sql | names | steward
    status: Mapped[str] = mapped_column(String(10), default="suggested")
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0)
    stats: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)            # value-overlap check: percentages and counts only, never values
    decided_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)     # a steward's decision is never overwritten by a rebuild
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class CombinedMember(Base):
    """One data model inside a combined data model (Connection.db_type == "combined"), with the alias the AI model uses."""
    __tablename__ = "combined_members"
    __table_args__ = (UniqueConstraint("combined_id", "member_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    combined_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    alias: Mapped[str] = mapped_column(String(30))
    position: Mapped[int] = mapped_column(Integer, default=0)
