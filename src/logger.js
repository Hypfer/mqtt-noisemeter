module.exports = {
    info: (msg) => console.log(`${new Date().toISOString()} - INFO - ${msg}`),
    error: (msg) => console.log(`${new Date().toISOString()} - ERROR - ${msg}`),
    warn: (msg) => console.log(`${new Date().toISOString()} - WARN - ${msg}`),
    debug: (msg) => {
        if (process.env.DEBUG === 'true') {
            console.log(`${new Date().toISOString()} - DEBUG - ${msg}`);
        }
    }
};