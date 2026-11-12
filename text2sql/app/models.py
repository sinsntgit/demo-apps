from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, now

ROLES = ("admin", "steward", "analyst")   # steward = curates training data, sees dashboard


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
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


class Connection(Base):
    """A data model: one database (or file folder) plus its own training data."""
    __tablename__ = "connections"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
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


class ConnectionAccess(Base):
    __tablename__ = "connection_access"
    __table_args__ = (UniqueConstraint("connection_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


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
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)   # display name
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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    conversation: Mapped[Conversation] = relationship(back_populates="runs")


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
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
