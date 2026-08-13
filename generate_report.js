/**
 * 盈动收银系统可视化报表自动生成脚本
 * 功能：自动登录POS后台，获取各门店营业数据，生成可视化HTML报表，上传COS
 * 用法：node generate_report.js [--output /path/to/report.html]
 *
 * 环境变量：
 *   POS_USERNAME  - POS后台账号
 *   POS_PASSWORD  - POS后台密码
 *   COS_SECRET_ID  - 腾讯云COS SecretId
 *   COS_SECRET_KEY - 腾讯云COS SecretKey
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const API_BASE = 'https://zhyx.eingdong.com/service/index.php';
const USERNAME = process.env.POS_USERNAME || '15522567775-2';
const PASSWORD = process.env.POS_PASSWORD || '211314';

const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const COS_BUCKET = process.env.COS_BUCKET || 'mrhero-1252461064';
const COS_REGION = process.env.COS_REGION || 'ap-hongkong';
const COS_UPLOAD_KEY = process.env.COS_UPLOAD_KEY || 'cashier_report.html';

// 门店列表（硬编码兜底）
const STORES_FALLBACK = [
  { id: '67809', name: '每日英雄（仁恒置地广场店）', area: '南开区', address: '仁恒置地广场A馆B2层（车场入口旁）', phone: '17603321243' },
  { id: '67815', name: '每日英雄（梅江环宇城店）', area: '河西区', address: '解放南路689号中海环宇城F1-107(4号门旁边)', phone: '18920374952' },
  { id: '67816', name: '每日英雄（彩柒汇店）', area: '南开区', address: '彩柒汇生活广场BOOM优适健身旁', phone: '13821038320' },
  { id: '67817', name: '每日英雄（华苑店）', area: '西青区', address: '迎水道148号天业大厦一楼艾克仕健身进入', phone: '13032252425' },
  { id: '67818', name: '每日英雄（远洋店）', area: '河东区', address: '华捷道优适健身UGYM三楼前台', phone: '13132171337' },
  { id: '67819', name: '每日英雄（万科广场店）', area: '河西区', address: '广东路45号万科广场4楼屋顶停车场UGYM优适健身前厅', phone: '16600361730' },
  { id: '67820', name: '每日英雄（国金汇店）', area: '南开区', address: '国金汇UGYM LAB优适健身（9楼）', phone: '13821038320' },
  { id: '67821', name: '每日英雄（六纬路店）', area: '河东区', address: '万隆大厦优氧健身一楼', phone: '13132171337' },
];

// ============ 参数解析 ============
const args = process.argv.slice(2);
let outputPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) { outputPath = args[i + 1]; i++; }
}
if (!outputPath) {
  outputPath = path.join(process.cwd(), 'cashier_report.html');
}

// ============ 工具函数 ============

// 获取北京时间日期字符串
function getBeijingDate(date) {
  const d = date || new Date();
  return new Date(d.getTime() + 8 * 3600000).toISOString().split('T')[0];
}

// 获取本月1号的Unix时间戳（北京时间）
function getMonthStartTimestamp() {
  const today = getBeijingDate();
  const monthStart = today.substring(0, 7) + '-01T00:00:00+08:00';
  return Math.floor(new Date(monthStart).getTime() / 1000);
}

// 获取当前时间的Unix时间戳
function getNowTimestamp() {
  return Math.floor(Date.now() / 1000);
}

// HTTP POST请求
function apiPost(endpoint, params, token) {
  return new Promise((resolve, reject) => {
    const url = token
      ? `${API_BASE}/${endpoint}?token=${token}`
      : `${API_BASE}/${endpoint}`;
    const body = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error for ${endpoint}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${endpoint}`)); });
    req.write(body);
    req.end();
  });
}

// 从订单时间戳提取日期 (YYYY-MM-DD)
function timestampToDate(ts) {
  if (!ts) return null;
  const sec = parseInt(ts, 10);
  if (isNaN(sec)) return null;
  return new Date(sec * 1000 + 8 * 3600000).toISOString().split('T')[0];
}

// 从订单时间戳提取小时 (0-23)
function timestampToHour(ts) {
  if (!ts) return null;
  const sec = parseInt(ts, 10);
  if (isNaN(sec)) return null;
  return String(new Date(sec * 1000 + 8 * 3600000).getUTCHours());
}

// 提取短店名
function shortName(fullName) {
  const m = fullName.match(/[（(](.+?)[)）]/);
  return m ? m[1] : fullName;
}

// ============ 数据解析 ============

function parseStoreData(storeInfo, analysis, orders) {
  const aData = analysis.a_data || [];
  const bData = analysis.b_data || {};

  // 从a_data提取汇总指标
  const findVal = (label) => {
    const item = aData.find(a => a.label === label);
    return item ? item.value : 0;
  };

  const revenue = parseFloat(findVal('营业实收')) || 0;
  const visits = parseInt(findVal('访问量')) || 0;
  const customers = parseInt(findVal('支付顾客数')) || 0;
  const avgSpend = parseFloat(findVal('人均')) || 0;
  const tableTurnover = String(findVal('翻台率') || '0%');
  const memberRatio = String(findVal('会员占比') || '0%');
  const nonMemberRatio = String(findVal('非会员占比') || '0%');

  // 支付方式分布（来自a_data[0].question）
  const paymentQuestion = (aData[0] && aData[0].question) || {};
  const paymentBreakdown = {};
  for (const [key, val] of Object.entries(paymentQuestion)) {
    paymentBreakdown[key] = parseFloat(val) || 0;
  }

  // 订单类型收入和数量 (ts=堂食, zq=自取, ps=配送, kd=到店自提)
  const chart1 = bData.chart_1 || {};
  const chart2 = bData.chart_2 || {};
  const orderTypeRevenue = {
    ts: parseFloat(chart1.ts) || 0,
    zq: parseFloat(chart1.zq) || 0,
    ps: parseFloat(chart1.ps) || 0,
    kd: parseFloat(chart1.kd) || 0,
  };
  const orderTypes = {
    ts: parseInt(chart2.ts) || 0,
    zq: parseInt(chart2.zq) || 0,
    ps: parseInt(chart2.ps) || 0,
    kd: parseInt(chart2.kd) || 0,
  };

  // 退款
  const refund = parseFloat(bData['退款']) || 0;

  // 从订单列表计算日/小时维度数据
  const dailyRevenue = {};
  const dailyOrders = {};
  const hourlyRevenue = {};
  const hourlyOrders = {};
  const payTypes = {};
  let totalOrders = 0;
  let totalAmount = 0;

  for (const order of orders) {
    const ts = order.add_time || order.addtime || order.createtime;
    const date = timestampToDate(ts);
    const hour = timestampToHour(ts);
    // 金额字段兼容多种命名
    const amount = parseFloat(order.total_amount || order.pay_money || order.amount || order.reality_money || 0) || 0;
    // 支付方式
    const payType = order.pay_type || order.paytype || order.payType || '其他';

    if (date && date !== '0000-00-00') {
      dailyRevenue[date] = (dailyRevenue[date] || 0) + amount;
      dailyOrders[date] = (dailyOrders[date] || 0) + 1;
    }
    if (hour !== null) {
      hourlyRevenue[hour] = (hourlyRevenue[hour] || 0) + amount;
      hourlyOrders[hour] = (hourlyOrders[hour] || 0) + 1;
    }
    payTypes[payType] = (payTypes[payType] || 0) + 1;
    totalOrders++;
    totalAmount += amount;
  }

  return {
    id: storeInfo.id,
    name: shortName(storeInfo.name || storeInfo.full_name || ''),
    full_name: storeInfo.name || storeInfo.full_name || '',
    area: storeInfo.area || '',
    address: storeInfo.address || '',
    phone: storeInfo.phone || '',
    revenue: Math.round(revenue * 100) / 100,
    total_orders: totalOrders,
    visits: visits,
    customers: customers,
    avg_spend: Math.round(avgSpend * 100) / 100,
    table_turnover: tableTurnover,
    member_ratio: memberRatio,
    non_member_ratio: nonMemberRatio,
    refund: Math.round(refund * 100) / 100,
    daily_revenue: dailyRevenue,
    daily_orders: dailyOrders,
    hourly_revenue: hourlyRevenue,
    hourly_orders: hourlyOrders,
    payment_breakdown: paymentBreakdown,
    pay_types: payTypes,
    order_types: orderTypes,
    order_type_revenue: orderTypeRevenue,
  };
}

// ============ COS上传 ============
async function uploadToCOS(localPath) {
  const COS = require('cos-nodejs-sdk-v5');
  const cos = new COS({
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY,
  });
  return new Promise((resolve) => {
    const fileContent = fs.readFileSync(localPath);
    cos.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: COS_UPLOAD_KEY,
      Body: fileContent,
      ContentType: 'text/html; charset=utf-8',
    }, (err, data) => {
      if (err) {
        console.error('COS upload failed:', err.message || err);
        resolve(false);
      } else {
        console.log(`COS upload OK: https://${COS_BUCKET}.cos-website.${COS_REGION}.myqcloud.com/${COS_UPLOAD_KEY}`);
        resolve(true);
      }
    });
  });
}

// ============ 主流程 ============
(async () => {
  const startTime = Date.now();
  console.log('\n========== 盈动收银系统报表生成 ==========');
  const todayStr = getBeijingDate();
  console.log(`Beijing date: ${todayStr}`);

  try {
    // 1. 登录
    console.log('\n--- 登录POS后台 ---');
    const loginRes = await apiPost('/login', {
      username: USERNAME,
      password: PASSWORD,
    });

    if (loginRes.status !== 1 || !loginRes.token) {
      console.error('Login failed:', JSON.stringify(loginRes).substring(0, 200));
      process.exit(1);
    }
    const token = loginRes.token;
    console.log('Login OK, token:', token.substring(0, 20) + '...');

    // 2. 获取门店列表
    console.log('\n--- 获取门店列表 ---');
    let stores = STORES_FALLBACK;
    try {
      const storeListRes = await apiPost('/chain/get_store_list', {}, token);
      if (storeListRes.status === 1 && storeListRes.list && storeListRes.list.length > 0) {
        stores = storeListRes.list.map(s => ({
          id: String(s.id),
          name: s.name || s.store_name || '',
          area: s.area || s.district || '',
          address: s.address || s.addr || '',
          phone: s.phone || s.tel || '',
        }));
        console.log(`Got ${stores.length} stores from API`);
      } else {
        console.log('API store list empty, using fallback');
      }
    } catch (e) {
      console.log('Store list API error, using fallback:', e.message);
    }

    // 3. 日期范围（本月1号到今天）
    const starttime = getMonthStartTimestamp();
    const endtime = getNowTimestamp();
    console.log(`Date range: ${starttime} - ${endtime}`);

    // 4. 逐店获取数据
    console.log('\n--- 逐店获取数据 ---');
    const appStores = [];

    for (const store of stores) {
      process.stdout.write(`  ${store.name} ... `);
      try {
        // 切换到子门店
        await apiPost('/login/login_child_store', { storeid: store.id }, token);

        // 获取分析数据
        const analysisRes = await apiPost('/analysis/index', { storeid: store.id }, token);
        const analysis = analysisRes.status === 1 ? analysisRes : { a_data: [], b_data: {} };

        // 获取订单列表（分页获取全部）
        let allOrders = [];
        let page = 1;
        const pageSize = 500;
        while (true) {
          const ordersRes = await apiPost('/order/get_list_3', {
            storeid: store.id,
            starttime: starttime,
            endtime: endtime,
            page: page,
            pagesize: pageSize,
          }, token);
          const batch = ordersRes.list || ordersRes.data || [];
          allOrders = allOrders.concat(batch);
          if (batch.length < pageSize) break;
          page++;
          if (page > 50) break; // 安全限制
        }

        // 解析数据
        const storeData = parseStoreData(store, analysis, allOrders);
        appStores.push(storeData);
        console.log(`OK (orders: ${allOrders.length}, revenue: ${storeData.revenue})`);
      } catch (e) {
        console.log(`FAIL: ${e.message}`);
        // 即使失败也添加一个空数据门店，保证报表完整
        appStores.push({
          id: store.id,
          name: shortName(store.name || ''),
          full_name: store.name || '',
          area: store.area || '',
          address: store.address || '',
          phone: store.phone || '',
          revenue: 0,
          total_orders: 0,
          visits: 0,
          customers: 0,
          avg_spend: 0,
          table_turnover: '0%',
          member_ratio: '0%',
          non_member_ratio: '0%',
          refund: 0,
          daily_revenue: {},
          daily_orders: {},
          hourly_revenue: {},
          hourly_orders: {},
          payment_breakdown: {},
          pay_types: {},
          order_types: { ts: 0, zq: 0, ps: 0, kd: 0 },
          order_type_revenue: { ts: 0, zq: 0, ps: 0, kd: 0 },
        });
      }
    }

    // 5. 构建APP_DATA
    const monthStart = todayStr.substring(0, 7) + '-01';
    const appData = {
      brand: {
        name: '每日英雄品牌',
        update_time: `${monthStart} 00:00:00 至 ${todayStr} 23:59:59`,
      },
      stores: appStores,
    };

    console.log('\n--- 数据汇总 ---');
    let totalRev = 0, totalOrders = 0;
    for (const s of appStores) {
      totalRev += s.revenue;
      totalOrders += s.total_orders;
    }
    console.log(`Total revenue: ${totalRev.toFixed(2)}`);
    console.log(`Total orders: ${totalOrders}`);
    console.log(`Stores: ${appStores.length}`);

    // 6. 生成HTML
    console.log('\n--- 生成HTML报表 ---');
    const templatePath = path.join(__dirname, 'template.html');
    let template;
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf-8');
    } else {
      console.error('template.html not found!');
      process.exit(1);
    }
    const html = template.replace('/*__APP_DATA__*/', JSON.stringify(appData));
    fs.writeFileSync(outputPath, html, 'utf-8');
    console.log(`Report saved: ${outputPath} (${(html.length / 1024).toFixed(1)} KB)`);

    // 7. 上传到COS
    if (COS_SECRET_ID && COS_SECRET_KEY) {
      console.log('\n--- 上传到COS ---');
      const ok = await uploadToCOS(outputPath);
      if (ok) console.log('COS upload success');
      else console.error('COS upload failed');
    } else {
      console.log('\n--- 跳过COS上传（未配置密钥）---');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n========== 完成 (${elapsed}s) ==========\n`);

  } catch (e) {
    console.error('\nFATAL ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
