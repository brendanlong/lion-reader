---
layout: page
title: Changelog
permalink: /changelog/
---

Weekly summaries of user-visible changes in Lion Reader. Subscribe to the [changelog feed](/changelog.xml) for updates.

{% for post in site.changelog %}

## [{{ post.title }}]({{ post.url | relative_url }})

<time datetime="{{ post.date | date_to_xmlschema }}">{{ post.date | date: "%B %-d, %Y" }}</time>

{{ post.content }}

---

{% endfor %}
