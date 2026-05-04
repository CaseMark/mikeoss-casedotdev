-- Make Case Vault the canonical document blob store.
--
-- Mike keeps document/version metadata in Postgres while document_versions
-- store opaque case://vault/{vaultId}/objects/{objectId} references.

alter table public.case_document_links
  add column if not exists role text not null default 'source';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'case_document_links_role_check'
      and conrelid = 'public.case_document_links'::regclass
  ) then
    alter table public.case_document_links
      add constraint case_document_links_role_check
      check (role = any (array[
        'source'::text,
        'pdf_rendition'::text,
        'generated'::text
      ]));
  end if;
end $$;

drop index if exists public.case_document_links_version_unique;

create unique index if not exists case_document_links_version_unique
  on public.case_document_links(document_id, version_id, role);
