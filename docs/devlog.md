# Neon Bastion — devlog

## M1 — Core (v0.1.0, 2026-11-22)

The core is in: a 3D grid with glowing paths and tower pads, three tower types with distinct roles (Bolt — fast single-target DPS, Pulse — AoE swarm control, Frost — chill control), enemies that path to the core (grunts, runners, armored, bosses), wave spawning with escalation, a tight credit economy (kill income + wave bonus), upgrade/sell, core lives, and 3 dense hand-crafted maps with distinct identities. Live 3D menu with a screen stack, trauma shake, hit-stop, slow-mo on core hits, pooled particles, Web Audio synth SFX + generative music. No assist of any kind — no auto-place, no best-tower hint, no placement preview that solves the map. A `?map=N` seed path reaches every map for playtests (kept out of the player-facing UI).

Balance was tuned empirically against the bot harness, not guessed: the first numbers let a random-placement bot clear every map, so towers got pricier and weaker, enemies tougher, and the economy tighter until the gates held. The decision bot now clears map 1 with 15/20 lives, map 2 with 7/20, and map 3 with 2/20 — a real difficulty curve — while random placement loses on all three maps across three seeds, and bolt-only spam fails map 3 at wave 5.

What is NOT done yet: no real-browser FUN playtest (owed at the 01:30 run — the headless checks prove the game works, not that it is fun), no live site yet (repo creation + first push at the 01:30 run), maps 4–8, feel polish, progression, and the release pass (M2–M6).

## M2 — Map craft (v0.2.0, 2026-11-23)

Eight maps now, each with its own path shape, choke points, pad layout and accent: Switchback (five sharp turns), The Corridor (two parallel runs, middle pads cover both), The Circuit (a full perimeter loop), Serpent (the longest road, 58 cells), The Crucible (a winding maze, four bosses in the last wave). The live playtest of v0.1.0 came back GO on all three M1 maps — the 2-bolt opening holds waves 1–2 with zero leaks — and the balance work since then was all about the curve: maps 1–2 got a third boss in wave 6 after probing showed bolt-only spam cleared them, and the new maps were tuned until the decision bot clears all eight (10, 15, 10, 10, 5, 3, 20, 5 lives left) while random placement loses on every map and bolt-only spam fails on every map.

Three tuning lessons from this milestone. First, easing mid-waves starves the bot: cutting enemies cuts kill income, so the defense arrives at the boss waves poorer, not safer — the fix for a hard map is usually spacing (wider spawn gaps let two towers focus-fire) or a longer path, not fewer enemies. Second, the bot's upgrade appetite is part of the balance: an "expand before you upgrade" rewrite looked principled but made maps 5, 6 and 8 fail — L1 towers in bulk cannot kill bosses — so it was reverted within the hour; the upgrade-happy bot stays. Third, Serpent is the deliberate breather: its 58-cell road gives towers so much exposure that the decision bot clears it with 20/20 lives and zero leaks even after a third boss and extra runners were added. It is a power-fantasy valley after the Circuit's 3/20 squeeze, not a trivial map — random placement still loses there, and spam fails there.

Wave 1 now holds with a plain 2-bolt opening on all eight maps (verified by probe, zero leaks), so every map teaches before it punishes.
