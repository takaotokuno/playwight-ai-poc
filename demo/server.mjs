import http from 'node:http';

const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>顧客検索デモ</title>
<h1>顧客検索</h1><form><label>顧客名<input name="name"></label><button>検索</button></form>
<p role="status"></p><table><thead><tr><th>顧客番号</th><th>顧客名</th><th>契約状態</th></tr></thead><tbody></tbody></table>
<script>
const customers = [{id:'002', name:'山田花子', status:'契約中'}, {id:'001', name:'山田太郎', status:'解約'}];
document.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.querySelector('input').value;
  const rows = customers.filter(c => c.name.includes(input)).sort((a,b) => a.id.localeCompare(b.id));
  const body = document.querySelector('tbody'); body.replaceChildren();
  for (const customer of rows) {
    const row = document.createElement('tr');
    for (const value of [customer.id, customer.name, customer.status]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    } body.append(row);
  }
  document.querySelector('[role=status]').textContent = rows.length ? '' : '該当する顧客はありません';
});
</script></html>`;
http
  .createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(Number(process.env.DEMO_PORT || 4173), '127.0.0.1', () =>
    console.log('Demo server started.'),
  );
