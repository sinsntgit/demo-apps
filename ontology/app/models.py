from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, now

ROLES = ("admin", "ontologist", "viewer")   # ontologist = builds and edits; viewer = reads, exports, runs tests


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="ontologist")
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


class Ontology(Base):
    """One ontology. `content` is the current version; every saved change also lands in OntologyVersion."""
    __tablename__ = "ontologies"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    domain: Mapped[str] = mapped_column(String(500), default="")
    scope: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")          # reference notes / glossary given to the builder
    requirements: Mapped[str] = mapped_column(Text, default="")   # what the ontology must support, in the owner's words
    seed_use_cases: Mapped[list] = mapped_column(JSON, default=list)   # use cases the owner requires it to answer
    folder_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    material: Mapped[str] = mapped_column(Text, default="")       # what was read from the sources, as given to the model
    based_on: Mapped[str] = mapped_column(String(300), default="")   # "Pre-built library: X" or "Copy of Y" - where it started
    depth: Mapped[str] = mapped_column(String(20), default="standard")
    owner_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_email: Mapped[str] = mapped_column(String(255), default="")
    visibility: Mapped[str] = mapped_column(String(20), default="private")   # private | shared
    status: Mapped[str] = mapped_column(String(20), default="draft")         # draft | building | ready | failed
    model_label: Mapped[str] = mapped_column(String(255), default="")
    version: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Folder(Base):
    """A folder of ontologies. Access given on a folder applies to everything inside it, sub-folders included."""
    __tablename__ = "folders"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    owner_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    owner_email: Mapped[str] = mapped_column(String(255), default="")
    everyone: Mapped[str] = mapped_column(String(10), default="")       # '' | view | edit - access for all signed-in users
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class FolderAccess(Base):
    __tablename__ = "folder_access"
    __table_args__ = (UniqueConstraint("folder_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    level: Mapped[str] = mapped_column(String(10), default="view")      # view | edit


class Source(Base):
    """Source material an ontology is built from: an uploaded document, or a database schema (metadata only)."""
    __tablename__ = "sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    ontology_id: Mapped[int] = mapped_column(ForeignKey("ontologies.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="document")   # document | schema
    name: Mapped[str] = mapped_column(String(500))                      # file name, with its folder path when a folder was uploaded
    size: Mapped[int] = mapped_column(Integer, default=0)               # bytes of the original
    chars: Mapped[int] = mapped_column(Integer, default=0)              # characters of text extracted
    text: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(String(500), default="")          # e.g. "12 pages", "38 tables", or why nothing was read
    added_by: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class OntologyVersion(Base):
    __tablename__ = "ontology_versions"
    __table_args__ = (UniqueConstraint("ontology_id", "number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    ontology_id: Mapped[int] = mapped_column(ForeignKey("ontologies.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(String(500), default="")
    author: Mapped[str] = mapped_column(String(255), default="")
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    content: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class TestRun(Base):
    """One test-bed run: a use case checked against one version of an ontology."""
    __tablename__ = "test_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    ontology_id: Mapped[int] = mapped_column(ForeignKey("ontologies.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    user_email: Mapped[str] = mapped_column(String(255), default="")
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="running")   # running | done | error
    score: Mapped[float] = mapped_column(Float, default=0.0)             # 0..1, computed by the server
    verdict: Mapped[str] = mapped_column(String(20), default="")         # addressed | partly | not_addressed
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    model_label: Mapped[str] = mapped_column(String(255), default="")
    fixes_applied: Mapped[bool] = mapped_column(Boolean, default=False)
    baseline_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)   # a re-test of the same requirements as this run
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class Job(Base):
    """A background AI job (build, refine, explain, use cases, test). The UI polls it."""
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(30))
    ontology_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    ontology_name: Mapped[str] = mapped_column(String(255), default="")
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    user_email: Mapped[str] = mapped_column(String(255), default="")
    model_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    model_label: Mapped[str] = mapped_column(String(255), default="")
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)   # queued | running | done | error
    stage: Mapped[str] = mapped_column(String(255), default="")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    log: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    calls: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


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
