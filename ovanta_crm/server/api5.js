import { GET, POST, PUT, DELETE, bad } from './http.js';
import { customizationBundle, createField, updateField, setArchived, purgeField, saveLayout, resetLayout, ENTITIES_WITH_CUSTOM } from './customfields.js';

const entityOf = (e) => { if (!ENTITIES_WITH_CUSTOM.includes(e)) throw bad('Unknown record type'); return e; };
GET('/api/customization', () => customizationBundle());
POST('/api/customization/fields', ({ body, user }) => createField(user, entityOf(body.entity), body));
PUT('/api/customization/fields/:id', ({ params, body, user }) => updateField(user, params.id, body));
POST('/api/customization/fields/:id/archive', ({ params, user }) => setArchived(user, params.id, true));
POST('/api/customization/fields/:id/restore', ({ params, user }) => setArchived(user, params.id, false));
DELETE('/api/customization/fields/:id', ({ params, user }) => purgeField(user, params.id));
PUT('/api/customization/layout/:entity', ({ params, body, user }) => saveLayout(user, entityOf(params.entity), body));
DELETE('/api/customization/layout/:entity', ({ params, user }) => resetLayout(user, entityOf(params.entity)));
