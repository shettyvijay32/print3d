require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bucket = process.env.MINIO_BUCKET || 'customer-uploads';
const s3 = new S3Client({
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.MINIO_ROOT_USER || 'minioadmin', secretAccessKey: process.env.MINIO_ROOT_PASSWORD || 'minioadmin' }
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP images are accepted.'), ok);
  }
});

async function init() {
  const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
    description TEXT DEFAULT '', image_url TEXT DEFAULT '', base_price NUMERIC(12,2) DEFAULT 0,
    active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS custom_requests (
    id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
    customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
    description TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
    photo_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted',
    quote_amount NUMERIC(12,2), currency TEXT DEFAULT 'INR', quote_notes TEXT,
    estimated_days INTEGER, quote_created_at TIMESTAMPTZ,
    payment_reference TEXT, payment_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  `;
  await pool.query(schema);
  const email = process.env.ADMIN_EMAIL || 'admin@printora.local';
  const pass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (!exists.rowCount) {
    const hash = await bcrypt.hash(pass, 12);
    await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin')", ['Printora Admin', email, hash]);
  }
  const count = await pool.query('SELECT count(*) FROM products');
  if (Number(count.rows[0].count) === 0) {
    const demo = [
      ['Articulated Dragon', 'Toys & Collectibles', 'Flexible articulated fantasy dragon. Choose your preferred colour.', 499],
      ['Personalized Name Keychain', 'Personalized Gifts', 'Custom name keychain, made to order.', 149],
      ['Desk Phone Stand', 'Desk Accessories', 'Compact phone stand for your desk.', 249],
      ['Modern Mini Planter', 'Home Decor', 'Decorative planter for small plants.', 299],
      ['Cable Organizer', 'Desk Accessories', 'Keep charging cables neat and organized.', 99],
      ['Custom Lithophane', 'Personalized Gifts', 'A photo transformed into a light-through 3D keepsake. Quote required.', 0]
    ];
    for (const p of demo) await pool.query('INSERT INTO products(name,category,description,base_price) VALUES($1,$2,$3,$4)', p);
  }
  // MinIO may take a little longer than the API pod to become ready.
  let bucketReady = false;
  for (let attempt = 1; attempt <= 12 && !bucketReady; attempt++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketReady = true;
    } catch (e) {
      const message = String(e);
      if (message.includes('BucketAlreadyOwnedByYou') || message.includes('BucketAlreadyExists')) {
        bucketReady = true;
      } else {
        console.log(`MinIO bucket setup attempt ${attempt}/12: ${e.message}`);
        if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  if (!bucketReady) throw new Error('Could not initialize MinIO bucket after retries');
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(raw, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
}
function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

app.get('/health', (_req,res) => res.json({ ok: true, service: 'Printora 3D API' }));

app.post('/api/auth/register', asyncRoute(async (req,res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and password (8+ characters) are required.' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const r = await pool.query("INSERT INTO users(name,email,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name,email,phone,role", [name,email.toLowerCase(),phone || null,hash]);
    res.status(201).json({ user:r.rows[0], token:tokenFor(r.rows[0]) });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error:'Email already registered.' }); throw e; }
}));

app.post('/api/auth/login', asyncRoute(async (req,res) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
  if (!r.rowCount || !(await bcrypt.compare(password || '', r.rows[0].password_hash))) return res.status(401).json({ error:'Invalid email or password.' });
  const u = r.rows[0]; res.json({ user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role}, token:tokenFor(u) });
}));

app.get('/api/products', asyncRoute(async (_req,res) => {
  const r = await pool.query('SELECT * FROM products WHERE active=true ORDER BY created_at DESC');
  res.json(r.rows);
}));

app.post('/api/requests', auth, upload.single('photo'), asyncRoute(async (req,res) => {
  const { customerName, email, phone, description, quantity } = req.body;
  if (!req.file || !customerName || !email || !description) return res.status(400).json({ error:'Photo, name, email and description are required.' });
  const key = `${Date.now()}-${crypto.randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  await s3.send(new PutObjectCommand({ Bucket:bucket, Key:key, Body:req.file.buffer, ContentType:req.file.mimetype }));
  const r = await pool.query(
    `INSERT INTO custom_requests(user_id,customer_name,email,phone,description,quantity,photo_key)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,created_at`,
    [req.user.id,customerName,email,phone || null,description,Math.max(1,Math.min(1000,Number(quantity)||1)),key]
  );
  res.status(201).json({ ...r.rows[0], message:'Request received. We will review your photo and send a quotation.' });
}));

app.get('/api/requests/mine', auth, asyncRoute(async (req,res) => {
  const r = await pool.query('SELECT id,customer_name,description,quantity,status,quote_amount,currency,quote_notes,estimated_days,payment_reference,payment_verified,created_at,updated_at FROM custom_requests WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
  res.json(r.rows);
}));

app.post('/api/requests/:id/approve-quote', auth, asyncRoute(async (req,res) => {
  const r = await pool.query("UPDATE custom_requests SET status='awaiting_payment',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='quoted' RETURNING id,status,quote_amount,currency",[req.params.id,req.user.id]);
  if (!r.rowCount) return res.status(400).json({ error:'Quote is not available for approval.' });
  res.json({ ...r.rows[0], message:'Quote approved. Please follow the payment instructions from the business.' });
}));

app.post('/api/requests/:id/payment-reference', auth, asyncRoute(async (req,res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error:'Payment reference is required.' });
  const r = await pool.query("UPDATE custom_requests SET payment_reference=$1,status='payment_review',updated_at=now() WHERE id=$2 AND user_id=$3 AND status='awaiting_payment' RETURNING id,status",[reference,req.params.id,req.user.id]);
  if (!r.rowCount) return res.status(400).json({ error:'This order is not awaiting payment.' });
  res.json({ ...r.rows[0], message:'Payment reference submitted for verification.' });
}));

app.get('/api/admin/requests', auth, admin, asyncRoute(async (_req,res) => {
  const r = await pool.query('SELECT * FROM custom_requests ORDER BY created_at DESC');
  const rows = await Promise.all(r.rows.map(async row => {
    const url = await getSignedUrl(s3, new GetObjectCommand({Bucket:bucket,Key:row.photo_key}), {expiresIn:3600});
    return {...row, photo_url:url};
  }));
  res.json(rows);
}));

app.post('/api/admin/requests/:id/quote', auth, admin, asyncRoute(async (req,res) => {
  const { amount, currency='INR', notes='', estimatedDays=7 } = req.body || {};
  if (!(Number(amount) > 0)) return res.status(400).json({ error:'Quote amount must be greater than zero.' });
  const r = await pool.query(
    "UPDATE custom_requests SET quote_amount=$1,currency=$2,quote_notes=$3,estimated_days=$4,status='quoted',quote_created_at=now(),updated_at=now() WHERE id=$5 RETURNING id,status,quote_amount,currency",
    [amount,currency,notes,estimatedDays,req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error:'Request not found.' });
  res.json(r.rows[0]);
}));

app.patch('/api/admin/requests/:id/status', auth, admin, asyncRoute(async (req,res) => {
  const allowed = ['payment_verified','printing','quality_check','shipped','delivered','cancelled','declined'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error:'Invalid status.' });
  const r = await pool.query('UPDATE custom_requests SET status=$1,payment_verified=CASE WHEN $1=$2 THEN true ELSE payment_verified END,updated_at=now() WHERE id=$3 RETURNING id,status,payment_verified',[req.body.status,'payment_verified',req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error:'Request not found.' });
  res.json(r.rows[0]);
}));

app.post('/api/admin/products', auth, admin, asyncRoute(async (req,res) => {
  const {name,category='General',description='',image_url='',base_price=0} = req.body || {};
  if (!name) return res.status(400).json({error:'Product name is required.'});
  const r = await pool.query('INSERT INTO products(name,category,description,image_url,base_price) VALUES($1,$2,$3,$4,$5) RETURNING *',[name,category,description,image_url,base_price]);
  res.status(201).json(r.rows[0]);
}));
app.patch('/api/admin/products/:id', auth, admin, asyncRoute(async (req,res) => {
  const {name,category,description,image_url,base_price,active} = req.body || {};
  const r = await pool.query('UPDATE products SET name=COALESCE($1,name),category=COALESCE($2,category),description=COALESCE($3,description),image_url=COALESCE($4,image_url),base_price=COALESCE($5,base_price),active=COALESCE($6,active) WHERE id=$7 RETURNING *',[name,category,description,image_url,base_price,active,req.params.id]);
  if (!r.rowCount) return res.status(404).json({error:'Product not found.'});
  res.json(r.rows[0]);
}));
app.delete('/api/admin/products/:id', auth, admin, asyncRoute(async (req,res) => {
  await pool.query('UPDATE products SET active=false WHERE id=$1',[req.params.id]); res.json({ok:true});
}));

app.use((err,_req,res,_next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Unexpected server error.' });
});

const port = Number(process.env.PORT || 4000);
init().then(() => app.listen(port,'0.0.0.0',()=>console.log(`Printora API listening on ${port}`)))
  .catch(err => { console.error('Startup failed',err); process.exit(1); });
