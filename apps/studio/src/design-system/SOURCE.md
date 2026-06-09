# Tidebase Design System Source

These files are copied from:

```text
/Users/yao/Learning/Tidebase Design System
```

Treat that folder as the source of truth for Tidebase tokens, brand assets, and design-system guidance. The Studio app vendors a copy here so the open-source repository builds without depending on a local absolute path.

When the source design system changes, resync:

```bash
cp -R ../"Tidebase Design System"/tokens apps/studio/src/design-system/
cp ../"Tidebase Design System"/styles.css apps/studio/src/design-system/styles.css
cp ../"Tidebase Design System"/assets/tidebase-mark.svg apps/studio/static/tidebase-mark.svg
cp ../"Tidebase Design System"/assets/tidebase-mark-mono.svg apps/studio/static/tidebase-mark-mono.svg
cp ../"Tidebase Design System"/assets/favicon.svg apps/studio/static/favicon.svg
```
