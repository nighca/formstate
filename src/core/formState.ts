import { action, computed, isArrayLike, isObservable, observable, runInAction } from 'mobx';
import { isMapLike } from "../internal/utils";
import { applyValidators, ComposibleValidatable, Validator } from './types';

/** Each key of the object is a validatable */
export type ValidatableMapOrArray =
  /** Mode: object */
  | { [key: string]: ComposibleValidatable<any> }
  /** Mode: array */
  | ComposibleValidatable<any>[]
  /** Mode: map */
  | Map<any, ComposibleValidatable<any>>

/**
 * Just a wrapper around the helpers for a set of FieldStates or FormStates
 */
export class FormState<TValue extends ValidatableMapOrArray> implements ComposibleValidatable<TValue> {
  protected mode: 'object' | 'array' | 'map' = 'object';
  constructor(
    /**
     * SubItems can be any Validatable
     */
    public $: TValue
  ) {
    this.mode = isArrayLike($) ? 'array' : isMapLike($) ? 'map' : 'object';

    /** If they didn't send in something observable make the local $ observable */
    if (!isObservable(this.$)) {
      this.$ = observable(this.$);
    }
  }

  /** Get validatable objects from $ */
  protected getValues = (): ComposibleValidatable<any>[] => {
    if (this.mode === 'array') return (this.$ as any);
    if (this.mode === 'map') return Array.from(
      (this.$ as Map<any, ComposibleValidatable<any>>).values()
    );
    const keys = Object.keys(this.$);
    return keys.map((key) => this.$[key]);
  }

  @observable validating = false;

  protected _validators: Validator<TValue>[] = [];
  @action validators = (...validators: Validator<TValue>[]) => {
    this._validators = validators;
    return this;
  }

  /**
   * - Re-runs validation on all fields
   * - returns `hasError`
   * - if no error also return the validated values against each key.
   */
  @action async validate(): Promise<{ hasError: true } | { hasError: false, value: TValue }> {
    this.validating = true;
    const values = this.getValues();
    let fieldsResult = await Promise.all(values.map((value) => value.validate()));
    const done = runInAction(() => {
      if (fieldsResult.some(f => f.hasError)) {
        this.validating = false;
        return true;
      }
      return false
    });
    if (done) return { hasError: true as true };

    /** Otherwise do any local validations */
    const error = await applyValidators(this.$, this._validators || []);
    const res = runInAction(() => {
      if (error != this._error) {
        this._error = error;
      }
      this.validating = false;

      const hasError = !!error;
      if (hasError) {
        return { hasError: true as true };
      }

      this._on$ValidationPass();
      return { hasError: false as false, value: this.$ };
    });

    return res;
  }

  @observable protected _error: string | null | undefined = '';

  /**
   * Does any field or form have an error
   */
  @computed get hasError() {
    return this.hasFieldError || this.hasFormError;
  }

  /**
   * Does any field have an error
   */
  @computed get hasFieldError() {
    return this.getValues().some(f => f.hasError);
  }

  /**
   * Does form level validation have an error
   */
  @computed get hasFormError() {
    return !!this._error;
  }

  /**
   * Call it when you are `reinit`ing child fields
   */
  @action clearFormError() {
    this._error = '';
  }

  /**
   * Error from some sub field if any
   */
  @computed get fieldError() {
    const subItemWithError = this.getValues().find(f => !!f.hasError);
    return subItemWithError ? subItemWithError.error : null;
  }

  /**
   * Error from form if any
   */
  @computed get formError() {
    return this._error;
  }

  /**
   * The first error from any sub (if any) or form error
   */
  @computed get error() {
    return this.fieldError || this.formError;
  }

  /**
   * You should only show the form error if there are no field errors
   */
  @computed get showFormError() {
    return !this.hasFieldError && this.hasFormError;
  }

  /**
   * Resets all the fields in the form
   */
  @action reset = () => {
    this.getValues().map(v => v.reset());
  }

  /**
   * Auto validation
   */
  @observable protected autoValidationEnabled = false;
  @action public enableAutoValidation = () => {
    this.autoValidationEnabled = true;
    this.getValues().forEach(x => x.enableAutoValidation());
  }
  @action public enableAutoValidationAndValidate = () => {
    this.enableAutoValidation();
    return this.validate();
  }
  @action public disableAutoValidation = () => {
    this.autoValidationEnabled = false;
    this.getValues().forEach(x => x.disableAutoValidation());
  }

  /**
   * Composible field validation tracking
   */
  @observable validatedSubFields: ComposibleValidatable<any>[] = [];

  /**
   * Composible fields (fields that work in conjuction with FormState)
   */
  @action compose() {
    const values = this.getValues();
    values.forEach(value => value._setCompositionParent(
      {
        on$Reinit: action(() => {
          this.validatedSubFields = this.validatedSubFields.filter(v => v !== value);
        }),
        on$ValidationPass: action(() => {
          /** Always clear the form error as its no longer relevant */
          if (this.hasFormError) {
            this.clearFormError();
          }

          /** Add the field to the validated sub fields */
          if (this.validatedSubFields.indexOf(value) === -1) {
            this.validatedSubFields.push(value);
          }

          /**
           * Compose triggers an automatic self validation of the form based on this criteria
           */
          if (
            /** If no field has error */
            !this.hasFieldError
            /** And there isn't an active validation taking place */
            && !this.validating
            /** And all subfields are validated */
            && !this.getValues().some(value => this.validatedSubFields.indexOf(value) === -1)
          ) {
            this.validate();
          }
        })
      }
    ));
    return this;
  }

  _on$ValidationPass = () => { }
  _on$Reinit = () => { }
  @action _setCompositionParent = (config: {
    on$ValidationPass: () => void;
    on$Reinit: () => void;
  }) => {
    this._on$ValidationPass = () => runInAction(config.on$ValidationPass);
    this._on$Reinit = () => runInAction(config.on$Reinit);
  }
}
