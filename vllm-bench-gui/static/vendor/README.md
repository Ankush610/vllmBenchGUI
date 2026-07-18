# Vendor files

Place `apexcharts.min.js` here for fully offline operation:

```bash
curl -fsSL -o apexcharts.min.js \
  https://cdn.jsdelivr.net/npm/apexcharts@3.49.1/dist/apexcharts.min.js
```

`run.sh` attempts this automatically on first launch. If the file is absent,
the frontend falls back to loading ApexCharts from the jsdelivr CDN; if that
also fails (fully offline machine), the dashboard shows a notice in place of
the charts — everything else keeps working.
