-- A stake recorded by checkAndRecordStake whose bet was then refused stops counting
-- toward limits once a STAKE_RELEASED row with the same ref exists.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'DEPOSIT', 'DEPOSIT_DECLINED', 'STAKE', 'STAKE_RELEASED', 'SETTLEMENT', 'WITHDRAWAL', 'WITHDRAWAL_CANCELLED'));
