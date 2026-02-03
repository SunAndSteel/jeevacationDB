# jeevacationDB

Recherche FTS dans le dataset compressé (9-12)

## Utilisation

1. `Set-ExecutionPolicy Unrestricted`
2. Exécuter le script `start.ps1`

## Indexation (Deno)

```bash
deno run -A index_records_txt.ts --input ./epstein-justice-files-text/Datasets-9-12 --db /chemin/vers/records.sqlite --run content --dedupe 1 --chunk-size 2000
```

### Exemples de requêtes :

- `epstein`
- `"training program"`
- `Tamince OR Rixos`
- `passport AND Antalya`

[Docu Full-Text Query Syntax](https://docs.faircom.com/doc/fts/72534.htm)

## Optimisations DB (FTS + léger)

- Stockage du `source_file` au niveau `docs` pour éviter la duplication par chunk (les chunks gardent `source_file` à `NULL`). Cela allège la DB et reste rétro-compatible via `COALESCE`.【F:index_records_txt.ts†L109-L213】【F:server/handlers.ts†L20-L139】
- Tokenizer FTS5 en `unicode61 remove_diacritics 2` pour des recherches accent-insensibles sans alourdir le texte stocké.【F:index_records_txt.ts†L137-L146】
- PRAGMA d'indexation orientées perf + WAL + checkpoint + `optimize`/`ANALYZE`/`VACUUM` déjà en place pour compacter et accélérer le FTS.【F:index_records_txt.ts†L109-L260】
