# Dependency graph tab

## Approved intent

Extend the existing Ensemble dashboard with a Dependency graph tab showing
how tasks depend on other tasks and which agent owns each task. The user
approved the interactive mockup on 2026-10-12 ("looks great").

## Behavior

- Keep the existing dashboard as the default Overview tab, unchanged.
- Show all tasks in the selected team, including unassigned and disconnected tasks.
- Arrange task cards left to right; arrows run prerequisite → dependent.
- Cards show task content, task status, assignee, and available agent status/type/model.
- Clicking a card shows its prerequisites and dependents in a detail region.
- Assigned, present agents link to the existing agent drawer.
- Refresh with existing dashboard polling; keep the selected tab and graph scroll position.
- Team changes must not show another team's selected task details.
- Include readable empty states, keyboard-accessible controls, and text status labels.

## Builder choices and constraints

- No new runtime dependencies; use HTML/CSS cards and SVG connectors.
- No database or `/api/state` schema changes; no new OpenCode tools.
- Missing prerequisites are labeled rather than silently discarded.
- Cyclic dependencies must not hang rendering; show a warning and all task cards.
- Escape all task and member data used in HTML and attributes.
- Use the existing OpenCode V2-compatible plugin entrypoint, unchanged.
- Deliver source in a feature branch of the user's fork with installation instructions.
- Do not publish to npm or change the user's installed plugin/configuration.
