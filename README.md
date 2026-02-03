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
