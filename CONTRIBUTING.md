# Contributing

Never commit session files, cookies, tokens, HAR captures, or real call titles, participants, transcripts, account or deal names. Tests use made-up ids and recorded shapes only.

```sh
npm install
npm run check
```

Every call must be one Gong's own web app makes to read the same data, listed in `READ_PATHS` in `src/api.ts`. Nothing that changes a call, shares it, comments, scores or touches settings.
