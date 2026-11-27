export interface PaymentMethod {
  platform: string;
  handle: string;
  preferred?: boolean;
}
