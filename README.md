# CRAAP Extension

CRAAP Extension is a research acceleration tool built to help students evaluate the credibility of online sources faster and more confidently.

It combines a Chrome extension interface with an AI-powered backend that analyzes webpages using the CRAAP framework (Currency, Relevance, Authority, Accuracy, Purpose), highlights key evidence, and provides quick research checks for easier source review.

## Why this project exists

Students often spend too much time deciding whether a source is trustworthy. This tool shortens that process by:

- Generating a fast credibility score and summary.
- Highlighting important passages directly on the page.
- Providing quick navigation checks and contextual callouts.
- Supporting citation-focused research workflows.

## Project structure

- `extension/` - Chrome extension frontend (popup UI, content scripts, styles).
- `backend/` - Flask + Gemini-based analysis pipeline API.

## Intended users

- Students doing literature reviews and assignments.
- Researchers who need quick first-pass source credibility checks.
- Educators teaching research literacy and source evaluation.
