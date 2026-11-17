# Accessibility

CampusPlug should be usable by as many people as possible, including people who navigate with a keyboard, use assistive technology, have low vision, or benefit from clear and predictable interfaces. This document describes the project's accessibility priorities, contributor expectations, and how to report barriers.

We are working toward a more accessible experience. This statement is not a claim that the application has been independently audited or verified as conformant to any accessibility standard.

## Priorities

We prioritize practical improvements that help people complete important tasks, including:

- **Keyboard access:** interactive controls should be reachable and usable without a mouse, with a visible focus indicator and a sensible focus order.
- **Screen readers and assistive technology:** controls should have meaningful names, form fields should have clear labels, and important status changes and errors should be communicated to assistive technology where appropriate.
- **Readable content:** use clear language, meaningful headings, descriptive link text, and instructions that do not rely on color, shape, position, or sound alone.
- **Visual clarity:** aim for sufficient text and control contrast, readable text sizes, usable zoom, and layouts that adapt to different viewport sizes.
- **Forms and errors:** identify required fields, explain validation errors in text, and help users understand how to correct a problem.
- **Motion and media:** avoid unnecessary motion and respect reduced-motion preferences where practical. Provide alternatives for meaningful audio or visual information when relevant.
- **Inclusive contribution:** make it possible to report an accessibility barrier without requiring a person to disclose a disability.

These are project priorities, not a statement that every area has already been tested or resolved.

## Contributor expectations

For changes that affect the user interface, contributors should:

- Preserve or improve keyboard navigation, focus visibility, and focus management.
- Use semantic HTML and native controls where appropriate; provide accessible names for custom controls.
- Associate labels and instructions with form fields and make validation feedback clear.
- Avoid using color as the only way to communicate status or meaning.
- Check layouts at narrow and wide viewport sizes and with browser zoom where practical.
- Consider loading states, empty states, error messages, dialogs, and dynamically updated content—not only the default screen.
- Run relevant automated checks available in the repository and perform manual checks appropriate to the change. Do not imply that a tool or test has been used unless it actually has.
- Include a brief note in the pull request describing accessibility considerations and checks performed. Screenshots or recordings may help explain a barrier or fix, but are optional.

When reporting test results, identify what was checked and any limitations. Automated tools can help find issues but cannot establish that an experience is accessible on their own.

## Reporting accessibility issues

If you encounter an accessibility barrier, please open an issue in the [CampusPlug GitHub repository](https://github.com/michaelkage/campus-plug67/issues). Use a clear title such as “Accessibility: keyboard focus is lost in the sign-in dialog.”

If you cannot use the issue tracker because of the barrier, contact a project maintainer through their GitHub profile or another contact method they have published.

Useful details include:
- The task you were trying to complete.
- The page or URL where the problem occurred.
- What you did, what happened, and what you expected to happen.
- Your browser, operating system, and device, if you know them.
- The input method or assistive technology involved, if you are comfortable sharing it.
- A workaround, if you found one.

Screenshots and recordings are optional. **You do not need to disclose a disability or medical information** to report an issue. Please remove passwords, access tokens, personal information, and other sensitive details before sharing logs or images. Use private reporting rather than a public issue for security vulnerabilities.

### Severity

You do not need to assign a severity level when reporting a barrier. Maintainers can assess its impact during triage. As a practical guide:

- **Blocking:** a person cannot complete an important task and no reasonable workaround is available—for example, keyboard users cannot submit a required form.
- **Major:** a task is possible only with significant difficulty or an unreliable workaround—for example, a dialog traps focus or an error is not announced.
- **Moderate:** a barrier makes part of the experience confusing or difficult, but a workaround exists.
- **Minor:** a usability improvement would make the experience clearer or more comfortable without blocking a task.

These labels are guidance for prioritization, not guaranteed resolution timelines.

### How we respond

Maintainers will review reports as time and project capacity allow. We aim to:
1. Confirm the affected experience and ask for clarification only when needed.
2. Assess the impact and prioritize barriers that prevent access to important tasks.
3. Share updates when practical and explain any available workaround.
4. Invite the reporter to verify the fix when possible.

We cannot promise a fixed acknowledgement or resolution time. Please avoid posting personal or sensitive information in a public report.

## Ownership and maintenance

Project maintainers are responsible for considering accessibility in design decisions, reviewing reported barriers, and updating this statement as practices evolve. Contributors can help by raising concerns early and documenting the checks they perform.

This document should be reviewed when the project's accessibility practices or support arrangements change. It will be maintained by the repository maintainers; responsibility should pass to the maintainers if project ownership changes.

## Supported environments

CampusPlug is a web project. This repository does not currently publish a verified matrix of browser, operating-system, device, or assistive-technology combinations that have been tested for accessibility. Support should not be inferred for a combination solely because the site loads in it.

When reporting an issue, sharing your browser and assistive-technology details can help maintainers reproduce it. Contributors should test with the environments available to them and clearly record the scope of their checks.

## Known limitations

A complete, independently verified accessibility audit has not been documented in this statement. As a result, there may be barriers that have not yet been identified, and we do not claim that all pages or workflows are accessible.

If no issue has been filed for a barrier you encounter, please report it using the process above. A workaround can be included when known, but the absence of a documented issue does not mean that no barrier exists.

## Feedback and improvements

Suggestions for improving this statement or the project's accessibility practices are welcome through a GitHub issue or pull request. For an active barrier affecting access, please use the reporting process above so it can be triaged as a user-facing issue.
