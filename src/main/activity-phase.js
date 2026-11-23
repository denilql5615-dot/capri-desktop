'use strict';

const { randomUUID } = require('node:crypto');

function activityPhase(publish, name) {
  if (!publish) return () => {};
  const step = { id: randomUUID(), kind: 'phase', name };
  publish({ ...step, state: 'running' });
  return (state = 'done') => publish({ ...step, state });
}

async function duringActivity(publish, name, work) {
  const end = activityPhase(publish, name);
  try {
    const result = await work();
    end();
    return result;
  } catch (error) {
    end('failed');
    throw error;
  }
}

module.exports = { activityPhase, duringActivity };
