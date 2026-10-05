const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja Supabase
const SUPABASE_URL = "https://jmhszbxrldujgfxgwxtt.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptaHN6YnhybGR1amdmeGd3eHR0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTIwNDY0MywiZXhwIjoyMTA2NzgwNjQzfQ.a-siy_fMzCAZFpTnvOhExPDvr7_AmXvDxTjvD4B7k7o";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Upewnij się, że katalog 'files' istnieje
const filesDir = path.join(__dirname, 'files');
if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
}

// Konfiguracja Multer do wgrywania plików
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, filesDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'cn.dll');
    }
});
const upload = multer({ storage });

// Baza danych SQLite (jako lokalna kopia/fallback)
const dbPath = path.join(__dirname, 'licenses.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Błąd połączenia z SQLite:", err.message);
    else console.log("Połączono z lokalną bazą danych SQLite.");
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS licenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            expires_at DATETIME,
            hwid TEXT DEFAULT NULL,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// --- API DLA LOADERA C++ ---

// 1. Weryfikacja licencji w Supabase (z fallbackiem do SQLite)
app.post('/api/verify', async (req, res) => {
    const { key, hwid } = req.body;

    if (!key) {
        return res.status(400).json({ status: 'error', message: 'Brak klucza licencyjnego' });
    }

    try {
        const { data, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('key', key)
            .eq('is_active', true)
            .single();

        if (!error && data) {
            if (data.expires_at && new Date(data.expires_at) < new Date()) {
                return res.status(403).json({ status: 'expired', message: 'Licencja wygasła' });
            }

            if (!data.hwid && hwid) {
                await supabase.from('licenses').update({ hwid }).eq('id', data.id);
            } else if (data.hwid && data.hwid !== hwid) {
                return res.status(403).json({ status: 'hwid_mismatch', message: 'Niezgodność HWID' });
            }

            return res.json({ status: 'success', message: 'Licencja poprawna' });
        }
    } catch (sbErr) {
        console.warn("Błąd Supabase, sprawdzam SQLite:", sbErr.message);
    }

    db.get(`SELECT * FROM licenses WHERE key = ? AND is_active = 1`, [key], (err, row) => {
        if (err || !row) {
            return res.status(401).json({ status: 'invalid', message: 'Nieprawidłowy lub nieaktywny klucz' });
        }

        if (row.expires_at && new Date(row.expires_at) < new Date()) {
            return res.status(403).json({ status: 'expired', message: 'Licencja wygasła' });
        }

        if (!row.hwid && hwid) {
            db.run(`UPDATE licenses SET hwid = ? WHERE id = ?`, [hwid, row.id]);
        } else if (row.hwid && row.hwid !== hwid) {
            return res.status(403).json({ status: 'hwid_mismatch', message: 'Niezgodność HWID' });
        }

        return res.json({ status: 'success', message: 'Licencja poprawna' });
    });
});

// 2. Pobieranie pliku payloadu cn.dll
app.get('/api/download/cn.dll', (req, res) => {
    const filePath = path.join(__dirname, 'files', 'cn.dll');
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Plik cn.dll nie znajduje się w katalogu files/' });
    }
    res.download(filePath, 'cn.dll', (err) => {
        if (err && !res.headersSent) {
            res.status(500).json({ error: 'Błąd podczas pobierania pliku' });
        }
    });
});

// --- API WGRYWANIA I INFORMACJI O PLIKU DLL ---

// Informacje o obecnym pliku cn.dll (sprawdza Supabase Storage oraz lokalnie)
app.get('/admin/file-info', async (req, res) => {
    try {
        const { data, error } = await supabase.storage.from('cn.dll').list();
        if (!error && data && data.length > 0) {
            const file = data.find(f => f.name === 'cn.dll') || data[0];
            return res.json({
                exists: true,
                filename: file.name,
                size: file.metadata ? file.metadata.size : 0,
                sizeMB: file.metadata ? (file.metadata.size / (1024 * 1024)).toFixed(2) : '0.00',
                updatedAt: file.updated_at || file.created_at
            });
        }
    } catch (e) {}

    const filePath = path.join(__dirname, 'files', 'cn.dll');
    if (!fs.existsSync(filePath)) {
        return res.json({ exists: false });
    }
    const stats = fs.statSync(filePath);
    res.json({
        exists: true,
        filename: 'cn.dll',
        size: stats.size,
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        updatedAt: stats.mtime
    });
});

// Upload nowego pliku cn.dll (zapisuje lokalnie i wgrywa do Supabase Storage)
app.post('/admin/upload-dll', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Brak przesłanego pliku' });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const stats = fs.statSync(req.file.path);

    // Wysyłanie do Supabase Storage
    try {
        const { error } = await supabase.storage
            .from('cn.dll')
            .upload('cn.dll', fileBuffer, {
                contentType: 'application/x-msdownload',
                upsert: true
            });
        if (error) {
            console.error("Błąd wysyłania do Supabase Storage:", error);
        } else {
            console.log("Pomyślnie wgrano plik do Supabase Storage!");
        }
    } catch (sbErr) {
        console.error("Wyjątek Supabase Storage:", sbErr.message);
    }

    res.json({
        success: true,
        message: 'Pomyślnie zaktualizowano plik cn.dll',
        filename: 'cn.dll',
        size: stats.size,
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        updatedAt: stats.mtime
    });
});

// --- API PANELA ADMINISTRACYJNEGO (Supabase + SQLite) ---

// Generowanie nowej licencji
app.post('/admin/generate', async (req, res) => {
    const { days } = req.body;
    const newKey = "VANISH-" + uuidv4().substring(0, 8).toUpperCase();
    
    let expiresAt = null;
    if (days && parseInt(days) > 0) {
        const date = new Date();
        date.setDate(date.getDate() + parseInt(days));
        expiresAt = date.toISOString();
    }

    const { data, error } = await supabase.from('licenses').insert([
        { key: newKey, expires_at: expiresAt, is_active: true }
    ]).select();

    if (error) {
        console.error("Błąd zapisu w Supabase:", error);
        db.run(`INSERT INTO licenses (key, expires_at) VALUES (?, ?)`, [newKey, expiresAt], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            return res.json({ success: true, key: newKey, expires_at: expiresAt, source: 'sqlite' });
        });
    } else {
        db.run(`INSERT INTO licenses (key, expires_at) VALUES (?, ?)`, [newKey, expiresAt]);
        res.json({ success: true, key: newKey, expires_at: expiresAt, source: 'supabase' });
    }
});

// Pobieranie listy wszystkich licencji
app.get('/admin/licenses', async (req, res) => {
    const { data, error } = await supabase
        .from('licenses')
        .select('*')
        .order('id', { ascending: false });

    if (!error && data) {
        return res.json(data);
    }

    if (error) {
        console.error("Błąd pobierania z Supabase:", error);
    }

    db.all(`SELECT * FROM licenses ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Zmiana statusu licencji
app.post('/admin/toggle', async (req, res) => {
    const { id, is_active } = req.body;
    
    const { error } = await supabase.from('licenses').update({ is_active: is_active ? true : false }).eq('id', id);
    if (error) console.error("Błąd toggle w Supabase:", error);

    db.run(`UPDATE licenses SET is_active = ? WHERE id = ?`, [is_active ? 1 : 0, id], function(err) {
        res.json({ success: true });
    });
});

// Usuwanie licencji
app.delete('/admin/license/:id', async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase.from('licenses').delete().eq('id', id);
    if (error) console.error("Błąd delete w Supabase:", error);

    db.run(`DELETE FROM licenses WHERE id = ?`, [id], function(err) {
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Serwer Vanish.xyz uruchomiony!`);
    console.log(`Połączono z Supabase: ${SUPABASE_URL}`);
    console.log(`Panel admina: http://localhost:${PORT}`);
    console.log(`=================================`);
});
