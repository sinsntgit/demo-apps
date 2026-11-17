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


class DataSource(Base):
    """A reusable data source: a database connection, or a set of uploaded datasets and documents. Its tables
    are profiled and its documents read once; any number of ontologies can be built from it."""
    __tablename__ = "data_sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(20), default="files")            # database | files
    owner_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    owner_email: Mapped[str] = mapped_column(String(255), default="")
    visibility: Mapped[str] = mapped_column(String(20), default="private")    # private | shared (everyone signed in may use it)
    config_enc: Mapped[str] = mapped_column(Text, default="")                 # database connection, encrypted, password included
    documentation: Mapped[str] = mapped_column(Text, default="")             # what the data means: glossary, rules, data dictionary - by people
    sample_values: Mapped[bool] = mapped_column(Boolean, default=True)        # sample values may go to the AI model
    personal_samples: Mapped[bool] = mapped_column(Boolean, default=False)    # ...including columns that look like personal data
    keep_files: Mapped[Optional[bool]] = mapped_column(Boolean, default=True, nullable=True)   # keep a copy of uploaded datasets on the server
    graph_personal: Mapped[Optional[bool]] = mapped_column(Boolean, default=False, nullable=True)  # personal columns may be loaded into knowledge graphs
    status: Mapped[str] = mapped_column(String(20), default="empty")          # empty | ready | error
    error: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[list] = mapped_column(JSON, default=list)                   # what could not be read, from the last read
    refreshed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class DataSourceAccess(Base):
    __tablename__ = "data_source_access"
    __table_args__ = (UniqueConstraint("data_source_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    data_source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class DataSourceItem(Base):
    """One table (with its profile) or one document of a data source."""
    __tablename__ = "data_source_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    data_source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))                             # table | document
    name: Mapped[str] = mapped_column(String(500))
    file_name: Mapped[str] = mapped_column(String(500), default="")           # the uploaded file it came from
    size: Mapped[int] = mapped_column(Integer, default=0)
    chars: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")                       # document text
    profile: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)      # table profile (profiling.py)
    description: Mapped[str] = mapped_column(Text, default="")                # business description, written by a person (or drafted by AI)
    described_by_ai: Mapped[bool] = mapped_column(Boolean, default=False)     # the table description is an AI draft nobody has confirmed
    include: Mapped[bool] = mapped_column(Boolean, default=True)              # used when an ontology is built
    stored: Mapped[Optional[str]] = mapped_column(String(300), default="", nullable=True)  # kept copy of an uploaded dataset (data/datasets/...)
    note: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class OntologyDataSource(Base):
    __tablename__ = "ontology_data_sources"
    __table_args__ = (UniqueConstraint("ontology_id", "data_source_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    ontology_id: Mapped[int] = mapped_column(ForeignKey("ontologies.id", ondelete="CASCADE"), index=True)
    data_source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id", ondelete="CASCADE"), index=True)


class KnowledgeGraph(Base):
    """The knowledge graph of an ontology: how its classes and properties map onto tables and columns of its data
    sources, and the graph built from the rows (an embedded store in data/graphs/<store>)."""
    __tablename__ = "knowledge_graphs"
    id: Mapped[int] = mapped_column(primary_key=True)
    ontology_id: Mapped[int] = mapped_column(ForeignKey("ontologies.id", ondelete="CASCADE"), unique=True, index=True)
    mapping: Mapped[dict] = mapped_column(JSON, default=dict)                 # kg.clean_mapping shape
    mapping_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="none")           # none | building | ready | error
    error: Mapped[str] = mapped_column(Text, default="")
    store: Mapped[str] = mapped_column(String(200), default="")               # folder name under data/graphs
    built_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    built_version: Mapped[int] = mapped_column(Integer, default=0)            # ontology version it was built from
    built_by: Mapped[str] = mapped_column(String(255), default="")
    sources: Mapped[list] = mapped_column(JSON, default=list)                 # data source ids the graph holds data of
    stats: Mapped[dict] = mapped_column(JSON, default=dict)                   # counts per class / property, tables read, notes
    extracted: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)    # facts extracted from documents (kgdocs.py), with their review status
    refresh: Mapped[Optional[str]] = mapped_column(String(20), default="", nullable=True)   # "" | daily | weekly - scheduled rebuild
    refresh_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)          # whose access a scheduled rebuild runs with
    next_refresh_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    storage: Mapped[Optional[str]] = mapped_column(String(10), default="stored", nullable=True)   # stored (a copy on this server) | live (fetched when needed, memory only)
    live_minutes: Mapped[Optional[int]] = mapped_column(Integer, default=10, nullable=True)      # live: how long a fetched graph is reused, in memory
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
    data_source_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)   # jobs on a data source (no ontology)
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
    estimated: Mapped[bool] = mapped_column(Boolean, default=False)      # some token counts were estimated (provider reported none)
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
