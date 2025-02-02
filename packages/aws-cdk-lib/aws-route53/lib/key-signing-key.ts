import { Construct } from 'constructs';
import { IHostedZone } from './hosted-zone-ref';
import { CfnKeySigningKey } from './route53.generated';
import * as iam from '../../aws-iam';
import * as kms from '../../aws-kms';
import { Resource, IResource, Lazy, Names } from '../../core';
import { addConstructMetadata } from '../../core/lib/metadata-resource';

/**
 * Properties for constructing a Key Signing Key.
 */
export interface KeySigningKeyProps {
  /**
   * The hosted zone that this key will be used to sign.
   */
  readonly hostedZone: IHostedZone;

  /**
   * The customer-managed KMS key that that will be used to sign the records.
   *
   * The KMS Key must be unique for each KSK within a hosted zone. Additionally, the
   * KMS key must be an asymetric customer-managed key using the ECC_NIST_P256 algorithm.
   *
   * @see https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-dnssec-cmk-requirements.html
   */
  readonly kmsKey: kms.IKey;

  /**
   * The name for the key signing key.
   *
   * This name must be unique within a hosted zone.
   *
   * @default an autogenerated name
   */
  readonly keySigningKeyName?: string;

  /**
   * The status of the key signing key.
   *
   * @default ACTIVE
   */
  readonly status?: KeySigningKeyStatus;
}

/**
 * The status for a Key Signing Key.
 */
export enum KeySigningKeyStatus {
  /** The KSK is being used for signing. */
  ACTIVE = 'ACTIVE',
  /** The KSK is not being used for signing. */
  INACTIVE = 'INACTIVE',
}

/**
 * A Key Signing Key for a Route 53 Hosted Zone.
 */
export interface IKeySigningKey extends IResource {
  /**
   * The hosted zone that the key signing key signs.
   *
   * @attribute
   */
  readonly hostedZone: IHostedZone;

  /**
   * The name of the key signing key.
   *
   * @attribute
   */
  readonly keySigningKeyName: string;

  /**
   * The ID of the key signing key, derived from the hosted zone ID and its name.
   *
   * @attribute
   */
  readonly keySigningKeyId: string;
}

/**
 * The attributes of a key signing key.
 */
export interface KeySigningKeyAttributes {
  /**
   * The hosted zone that the key signing key signs.
   *
   * @attribute
   */
  readonly hostedZone: IHostedZone;

  /**
   * The name of the key signing key.
   *
   * @attribute
   */
  readonly keySigningKeyName: string;
}

/**
 * A Key Signing Key for a Route 53 Hosted Zone.
 *
 * @resource AWS::Route53::KeySigningKey
 */
export class KeySigningKey extends Resource implements IKeySigningKey {
  /**
   * Imports a key signing key from its attributes.
   */
  public static fromKeySigningKeyAttributes(scope: Construct, id: string, attrs: KeySigningKeyAttributes): IKeySigningKey {
    class Import extends Resource implements IKeySigningKey {
      public readonly keySigningKeyName: string;
      public readonly hostedZone: IHostedZone;

      constructor() {
        super(scope, id);
        this.keySigningKeyName = attrs.keySigningKeyName;
        this.hostedZone = attrs.hostedZone;
      }

      get keySigningKeyId() {
        return `${this.hostedZone.hostedZoneId}|${this.keySigningKeyName}`;
      }
    }

    return new Import();
  }

  public readonly hostedZone: IHostedZone;
  public readonly keySigningKeyName: string;
  public readonly keySigningKeyId: string;

  constructor(scope: Construct, id: string, props: KeySigningKeyProps) {
    super(scope, id, {
      physicalName: props.keySigningKeyName ?? Lazy.string({
        produce: () => Names.uniqueResourceName(this, { maxLength: 128, allowedSpecialCharacters: '_' }),
      }),
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    this.grantKeyPermissionsForZone(props.kmsKey, props.hostedZone);

    const resource = new CfnKeySigningKey(this, 'Resource', {
      hostedZoneId: props.hostedZone.hostedZoneId,
      keyManagementServiceArn: props.kmsKey.keyArn,
      name: this.physicalName,
      status: props.status ?? KeySigningKeyStatus.ACTIVE,
    });

    this.keySigningKeyId = resource.ref;
    // These values are easier to derive from the props than via parsing the `.ref`
    // attribute of the resource using `Fn::Split`
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53-keysigningkey.html#aws-resource-route53-keysigningkey-return-values
    this.hostedZone = props.hostedZone;
    this.keySigningKeyName = this.physicalName;
  }

  private grantKeyPermissionsForZone(key: kms.IKey, zone: IHostedZone): iam.Grant[] {
    // Grants are based on the recommended configuration to avoid the confused deputy problem
    // at https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/access-control-managing-permissions.html#KMS-key-policy-for-DNSSEC
    return [
      key.grant(
        new iam.ServicePrincipal('dnssec-route53.amazonaws.com', {
          conditions: {
            ArnEquals: {
              'aws:SourceArn': zone.hostedZoneArn,
            },
          },
        }),
        'kms:DescribeKey',
        'kms:GetPublicKey',
        'kms:Sign',
      ),
      key.grant(
        new iam.ServicePrincipal('dnssec-route53.amazonaws.com', {
          conditions: {
            Bool: {
              'kms:GrantIsForAWSResource': true,
            },
          },
        }),
        'kms:CreateGrant',
      ),
    ];
  }
}
