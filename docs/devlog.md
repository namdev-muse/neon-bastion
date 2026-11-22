# Neon Bastion — devlog

## M1 — Core (v0.1.0, 2026-11-22)

The core is in: a 3D grid with glowing paths and tower pads, three tower types with distinct roles (Bolt — fast single-target DPS, Pulse — AoE swarm control, Frost — chill control), enemies that path to the core (grunts, runners, armored, bosses), wave spawning with escalation, a tight credit economy (kill income + wave bonus), upgrade/sell, core lives, and 3 dense hand-crafted maps with distinct identities. Live 3D menu with a screen stack, trauma shake, hit-stop, slow-mo on core hits, pooled particles, Web Audio synth SFX + generative music. No assist of any kind — no auto-place, no best-tower hint, no placement preview that solves the map. A `?map=N` seed path reaches every map for playtests (kept out of the player-facing UI).

Balance was tuned empirically against the bot harness, not guessed: the first numbers let a random-placement bot clear every map, so towers got pricier and weaker, enemies tougher, and the economy tighter until the gates held. The decision bot now clears map 1 with 15/20 lives, map 2 with 7/20, and map 3 with 2/20 — a real difficulty curve — while random placement loses on all three maps across three seeds, and bolt-only spam fails map 3 at wave 5.

What is NOT done yet: no real-browser FUN playtest (owed at the 01:30 run — the headless checks prove the game works, not that it is fun), no live site yet (repo creation + first push at the 01:30 run), maps 4–8, feel polish, progression, and the release pass (M2–M6).
