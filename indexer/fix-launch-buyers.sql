-- One-off: opening buys were recorded with the factory as buyer. Credit the creator instead.
update trades t
set trader = c.creator
from coins c
where t.coin_id = c.id
  and t.trader in ('0xd72ef7a8134407b4ebc8d764f431457439bc901a', '0x00cb1e0bc065c821481411a95c0a2e1afa432919');
