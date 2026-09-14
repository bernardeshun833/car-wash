-- Development seed data for the car wash project. Dev only.
--
-- PIN hashes are PBKDF2-SHA256, 200000 iterations, generated with
-- `npm run hash-pin -- <pin>` (scripts/hash-pin.mjs). Never store a raw PIN,
-- and never reuse these hashes in production — the PINs below are public.
--
-- Dev PINs: Kofi 1234, Ama 2345, Yaw 3456.
--
-- Three attendants are seeded because the real headcount is still unconfirmed.
-- Nothing in the system depends on that number: PIN-per-transaction works the
-- same with one attendant as with six, and the per-attendant breakdown simply
-- has one row.

insert into attendants (id, branch_id, name, pin_hash, pin_salt, pin_iterations, active) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000b1a1', 'Kofi Asante',
   '55fb4e5859ddb05bfd8ccfdbab4a629d01909191cdb4ec285f6da3489df373b1', 'a1b2c3d4e5f60718', 200000, true),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000b1a1', 'Ama Boateng',
   '205b07ae3e8007ad5d7bdbbbfa966acd37904083d4c49908a7828a672c174aa5', 'b2c3d4e5f6071829', 200000, true),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-00000000b1a1', 'Yaw Owusu',
   '93400b70080840be011838a4e1fe4acb9ee5418cf3fe6b9c2dcbb9570960a258', 'c3d4e5f607182930', 200000, true);

-- The price list. `wash_type` is what is sold — the system never records what
-- kind of vehicle turned up, only that one did.
insert into vehicles_or_services (id, branch_id, wash_type, price, active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000b1a1', 'Body wash', 25.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000b1a1', 'Body + interior', 45.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000b1a1', 'Full valet', 80.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000b1a1', 'Engine wash', 40.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000b1a1', 'Underbody wash', 35.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000006', '00000000-0000-0000-0000-00000000b1a1', 'Bus / van wash', 120.00, true),
  ('aaaaaaaa-0000-0000-0000-000000000007', '00000000-0000-0000-0000-00000000b1a1', 'Motorbike wash', 15.00, true);

update branch_settings set
  owner_email = 'owner@example.com',
  owner_whatsapp = '+441234567890',
  -- Dev only. Both of these are false in production until the thing they
  -- describe actually exists: a registered MoMo merchant account, and a
  -- counting unit bolted to a pole in the yard.
  momo_enabled = false,
  vehicle_counting_enabled = true
where branch_id = '00000000-0000-0000-0000-00000000b1a1';
