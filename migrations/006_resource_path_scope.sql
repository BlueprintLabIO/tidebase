-- v0.7 (security review): per-resource path scoping for the proxy. When set, the
-- proxied request path must start with this prefix, so a grant cannot reach
-- arbitrary objects the upstream credential could otherwise access (narrows the
-- proxy from "verb + host" to "verb + host + path subtree"). Expand-only.
alter table resources add column if not exists allowed_path_prefix text;
