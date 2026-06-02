const { createClient } = require('@supabase/supabase-js');

let _service, _anon;

function serviceClient() {
    if (!_service) _service = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    return _service;
}

function anonClient() {
    if (!_anon) _anon = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
    );
    return _anon;
}

module.exports = { serviceClient, anonClient };
