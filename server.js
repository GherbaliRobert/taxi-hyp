const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

const config = loadConfig();
const { httpServer } = createApp(config);

httpServer.listen(config.port, () => {
  const base = `http://localhost:${config.port}`;
  console.log(`${config.companyName} pornit pe ${base}`);
  console.log(`  Dispecerat:  ${base}/`);
  console.log(`  Șofer:       ${base}/driver`);
});
