Read __PSTACK__/skills/maintain-verification-skill/SKILL.md and follow it for the verify skill in .claude/skills/verify-chromescribe.

You run alone on a GitHub runner with no subagents. Do the source wave yourself, one feature file at a time. The live pass uses the skill's own cs-verify launch, doctor, journey and cleanup commands. Seed with --seed real.

Also compare the feature map with the app. List every page in dashboard/public, every route in dashboard/src/index.ts, every CLI command in cli/README.md, and the shell pipelines process.sh, queue.sh and monitor.sh. Each must belong to a feature file through its paths: list. A user feature with no feature file is missing: add one with the four sections and a journey.

Edit only .claude/skills/verify-chromescribe and tools/feature-map.test.js. Never edit product code. Write no code comments.

Run node --test tools/feature-map.test.js before you finish.

End with exactly one line that is only clean, changed or blocked, then one paragraph of evidence: the features covered from source, the journeys run live with their results, and every product bug found.
