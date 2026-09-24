// Not a DTO / controller: internal rows may carry a password hash.
export interface UserRow {
  id: string;
  password_hash: string;
}
