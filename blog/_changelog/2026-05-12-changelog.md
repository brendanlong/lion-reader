---
title: "Removing the algorithmic feed"
date: 2026-05-12
author: Lion Reader
---

We've removed the **algorithmic feed** (the "Best" feed and entry voting system) from Lion Reader. This includes the machine learning model training, score predictions, vote controls, and the Best feed sorted by predicted score.

**Why?** The feature had low adoption and high maintenance costs. The background ML training jobs were a frequent source of worker flakiness, and the complexity of the scoring pipeline (TF-IDF vectorization, Ridge regression, inline prediction after feed fetches, weekly model retraining) wasn't justified by the number of users actively using it.

Your existing reading experience is unchanged — all other features (starring, saving, tagging, search, narration, AI summaries, etc.) continue to work exactly as before. The algorithmic feed settings page has also been removed from Settings.

We're keeping the underlying database data (scores, predictions, models) intact in case we decide to revisit personalized feeds in a different form in the future.
