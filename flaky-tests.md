# Flaky tests

- 2026-10-31: `ui/e2e/serial/terminal.spec.ts` › "keeps keyboard focus in the terminal after selecting text with the mouse" failed in the full `pn test` run and in 1 of 3 isolated reruns (passed in the other 2, and once on the commit before the vault UI). The selection never contained "select" within 15 s; the terminal showed a multi-line starship prompt, which scrolls the marker row away.
