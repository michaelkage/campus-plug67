# Contributing to CampusPlug

Thanks for your interest in contributing to CampusPlug! Contributions of code, documentation, bug reports, accessibility feedback, and thoughtful feature suggestions are welcome.

By participating, you agree to follow the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

1. Search existing issues and pull requests to see whether the problem or idea has already been discussed.
2. For a substantial feature or architectural change, open an issue first so the approach can be discussed before significant work begins.
3. For bugs, include the steps to reproduce the problem and what you expected to happen.
4. Never include passwords, API keys, access tokens, personal data, or production secrets in issues, commits, screenshots, or test fixtures. Use private security reporting for vulnerabilities when available.

## Ways to contribute

- **Bug fixes:** describe the failure and the conditions in which it occurs.
- **Features:** explain the user problem and why the proposed change helps.
- **Documentation:** improve setup instructions, explanations, examples, and troubleshooting.
- **Accessibility:** report barriers or improve keyboard access, labels, focus handling, contrast, and clear error messages.
- **Testing:** add or improve checks that help prevent regressions.

## Development workflow

1. Fork the repository or create a working branch from the current default branch.
2. Keep each change focused and use a descriptive branch name, such as `fix/payment-verification` or `docs/accessibility-guidance`.
3. Follow the existing project structure, naming, formatting, and coding conventions.
4. Make the smallest coherent change that solves the problem. Avoid unrelated refactors.
5. Add or update tests when practical, especially for bug fixes and behavior that could regress.
6. Run the relevant checks documented in the repository, such as its package scripts or CI workflows. Do not claim a check passed unless you ran it and confirmed the result.
7. Review your own diff for accidental changes, secrets, debug output, generated files, and unrelated formatting.
8. Open a pull request with a clear summary, the reason for the change, how it was tested, and any relevant issue links.

## Pull request expectations

A helpful pull request should:
- Explain **what changed** and **why**.
- Link related issues where applicable.
- Include test results and clearly state any checks you could not run.
- Include screenshots or a short recording for meaningful user-interface changes when useful; these are optional and should not expose private data.
- Mention accessibility implications for user-facing changes.
- Call out database migrations, environment-variable changes, API changes, and deployment implications.
- Be reasonably scoped and easy to review.

Please do not combine unrelated changes into one pull request. Maintainers may ask for revisions, additional tests, or a narrower scope before merging.

## Code and security guidelines

- Never commit secrets or real user data.
- Validate untrusted input at appropriate boundaries and handle failures clearly.
- Avoid weakening authentication, authorization, validation, rate limits, or other security controls to make a test pass.
- Treat payment and account-related changes with extra care. Preserve existing transaction safeguards and avoid retry behavior that could cause duplicate actions.
- Keep error messages useful without exposing secrets or sensitive implementation details.
- Update relevant documentation when configuration or behavior changes.

## Accessibility

Consider keyboard-only use, visible focus, meaningful labels, readable content, sufficient contrast, and clear feedback for errors and status changes. Do not rely on color alone to communicate important information. See [ACCESSIBILITY.md](ACCESSIBILITY.md) for the project's accessibility guidance and reporting process.

## Reporting bugs and requesting features

Use the repository's GitHub issue tracker for reproducible bugs, feature proposals, and non-sensitive accessibility issues. Include:
- The page or feature affected.
- Steps to reproduce and the expected versus actual behavior.
- Browser, operating system, and device details when relevant.
- Relevant console output with tokens, personal information, and other secrets removed.

Do not use public issues to disclose security vulnerabilities or private user information.

## Review and merging

Maintainers review contributions for correctness, clarity, security, accessibility, and fit with the project's direction. Passing automated checks is helpful but does not by itself guarantee acceptance. Please be patient and respond constructively to review feedback.

Thank you for helping improve CampusPlug!
