# KeyGraph

A keybr-style typing trainer with a 3D keyboard, plus **Key Defense**, a typing tower-defense game.

- **Trainer** (`/`): lessons unlock keys as you get faster, and a key-transition graph (finger travel and key sequence) shows which movements slow you down. There's also a daily practice goal.
- **Key Defense** (`/tower-defense/`): draft towers onto keys; they fire when you type that letter. Boss waves are built from your slowest keys. Up to 4 players can share a room via a code or link.

Static site, no build step. To run locally: `python3 -m http.server 8765`, then open http://localhost:8765.
