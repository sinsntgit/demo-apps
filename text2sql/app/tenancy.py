"""Companies (tenants): which shared AI models and email senders a company may use.

Every user belongs to one company. Company-owned rows carry `company_id`; the routers filter on it and
`deps.can_use` refuses a data model of another company. AI models and email senders can also be platform
items (company_id NULL), managed by a platform administrator and offered to all or to selected companies;
a company admin may switch a shared item off for their company and add their own.
"""
from sqlalchemy import select

from .models import Company, EmailSender, LLMModel


def offered_to(item, company_id: int) -> bool:
    """A platform item is offered to this company (before the company's own on/off choice)."""
    return item.company_id is None and (item.share_all or company_id in (item.shared_companies or []))


def models_for(db, company_id: int, include_hidden: bool = False) -> list[LLMModel]:
    """AI models people in this company can pick: the company's own plus the shared ones it has not switched off."""
    company = db.get(Company, company_id)
    hidden = set((company.hidden_models if company else None) or [])
    out = []
    for m in db.scalars(select(LLMModel).order_by(LLMModel.name)):
        if m.company_id == company_id or (offered_to(m, company_id) and (include_hidden or m.id not in hidden)):
            out.append(m)
    return out


def senders_for(db, company_id: int, include_hidden: bool = False) -> list[EmailSender]:
    company = db.get(Company, company_id)
    hidden = set((company.hidden_senders if company else None) or [])
    return [s for s in db.scalars(select(EmailSender).order_by(EmailSender.label))
            if s.company_id == company_id or (offered_to(s, company_id) and (include_hidden or s.id not in hidden))]


def default_model(db, company_id: int, enabled_only: bool = True) -> LLMModel | None:
    company = db.get(Company, company_id)
    usable = [m for m in models_for(db, company_id) if m.enabled or not enabled_only]
    by_id = {m.id: m for m in usable}
    if company and company.default_model_id in by_id:
        return by_id[company.default_model_id]
    own = [m for m in usable if m.company_id == company_id and m.is_default]
    shared = [m for m in usable if m.company_id is None and m.is_default]
    return (own or shared or usable or [None])[0]


def name_clash(db, company_ids: list[int] | None, name: str, exclude_id: int | None, model=LLMModel, field="name") -> str | None:
    """A model / sender name must be unique among everything one company sees. Returns a clashing company's name."""
    want = name.strip().lower()
    for item in db.scalars(select(model)):
        if item.id == exclude_id or getattr(item, field).strip().lower() != want:
            continue
        for cid in company_ids or [c.id for c in db.scalars(select(Company))]:
            if item.company_id == cid or offered_to(item, cid):
                c = db.get(Company, cid)
                return c.name if c else f"#{cid}"
    return None
