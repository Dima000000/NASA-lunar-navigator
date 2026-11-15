# AI assistance record

We used AI assistants: Anthropic Claude (prototype UI, early code, review
and documentation drafts) and OpenAI Codex (implementation, data
preparation scripts, tests, browser checks, documentation).

The team defined the concept, goals, interface and scientific assumptions,
and reviewed and accepted every change. AI-generated code and numbers were
checked against JPL Horizons (4,326 comparisons), published illumination
studies, input checksums, automated tests and manual browser review.
No AI-generated images are presented as lunar observations.

| Material | Assistance and verification |
|---|---|
| Application modules and workers | Codex-assisted implementation; unit checks and browser scenarios |
| Data processing and delivery | Codex-assisted scripts; source attribution, SHA-256 checks and lossless array comparisons |
| Ephemeris and illumination comparisons | Codex-assisted calculations/scripts; independent JPL Horizons and cited primary publications |
| Documentation | Codex-assisted drafting; no claim that automated checks constitute team approval |

NASA/JPL observations and scientific source products are not AI-generated. No generated lunar photographs are used. Final submission is handled by the team. Assistance is disclosed in README, package metadata and the HTML generator metadata as well as this record.
